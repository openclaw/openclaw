"""
CodeValidator — статический анализ + фаззинг-проверки для сгенерированного кода.

Интегрируется в Brigade Pipeline между Executor и Auditor шагами:
  Executor (генерирует код) → CodeValidator (проверяет) → если ошибки → Executor исправляет → Auditor

Поддерживает:
  - semgrep   : SAST для Python + TypeScript (ищет CWE, OWASP Top-10)
  - bandit    : Специализированный Python security scanner (B-серия ошибок)
  - ruff      : Ультрабыстрый Python linter + formatter (PEP8, imports, bugs)
  - cargo-audit: Уязвимости в зависимостях Rust (src/rust_core)
  - ffuf      : HTTP-фаззинг API эндпоинта (8765) — запускается отдельным сценарием

Модели, которые получают результаты валидации:
  - Executor_API      : вся генерация Python-кода (aiohttp, requests)
  - Executor_Parser   : парсеры, обработка JSON/HTML
  - Executor_Tools    : инструменты, CLI-скрипты
  - Executor_Architect: архитектурный Python/TS код
  - Auditor           : получает итоговый отчёт для финальной проверки

Логика:
  1. Извлечь блоки кода из ответа модели (```python, ```typescript, ```rust)
  2. Записать во временный файл
  3. Запустить соответствующие инструменты
  4. Вернуть структурированный отчёт с (tool, severity, message, line)
  5. Если severity >= WARNING → pipeline передаёт ошибки обратно в Executor для исправления
"""

import asyncio
import json
import logging
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Максимальное количество итераций авто-исправления перед сдачей
MAX_FIX_ITERATIONS = 3

# Уровни серьёзности (CRITICAL блокирует, WARNING требует исправления)
SEVERITY_BLOCK = {"critical", "error", "high"}
SEVERITY_WARN = {"medium", "warning", "moderate"}


@dataclass
class ValidationIssue:
    """Одна найденная проблема."""
    tool: str           # "semgrep" | "bandit" | "ruff" | "cargo-audit"
    severity: str       # "critical" | "error" | "warning" | "info"
    message: str        # Описание проблемы
    line: int = 0       # Номер строки (0 = неизвестно)
    rule_id: str = ""   # ID правила (B101, E501, CWE-78 и т.д.)
    fix_hint: str = ""  # Подсказка по исправлению (если инструмент предоставил)

    def to_prompt_line(self) -> str:
        """Форматирует для вставки в промпт модели."""
        loc = f":L{self.line}" if self.line else ""
        hint = f" → Исправление: {self.fix_hint}" if self.fix_hint else ""
        return f"[{self.tool.upper()}][{self.severity.upper()}]{loc} {self.rule_id}: {self.message}{hint}"


@dataclass
class ValidationReport:
    """Полный отчёт по одному блоку кода."""
    language: str                           # "python" | "typescript" | "rust"
    issues: List[ValidationIssue] = field(default_factory=list)
    passed: bool = True                     # True если нет блокирующих ошибок

    def has_blocking_issues(self) -> bool:
        return any(i.severity.lower() in SEVERITY_BLOCK for i in self.issues)

    def has_warning_issues(self) -> bool:
        return any(i.severity.lower() in SEVERITY_WARN for i in self.issues)

    def format_for_model(self) -> str:
        """Человекочитаемый отчёт для передачи в промпт модели."""
        if not self.issues:
            return "✅ Статический анализ пройден без замечаний."
        lines = [f"⚠️ Найдено {len(self.issues)} проблем в {self.language}-коде:"]
        for issue in self.issues:
            lines.append("  " + issue.to_prompt_line())
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Детекция кодовых блоков из ответа модели
# ---------------------------------------------------------------------------

_CODE_BLOCK_RE = re.compile(
    r"```(?P<lang>python|py|typescript|ts|javascript|js|rust|rs|bash|sh)?\s*\n"
    r"(?P<code>.*?)"
    r"```",
    re.DOTALL | re.IGNORECASE,
)


def _normalize_lang(raw: Optional[str]) -> str:
    if not raw:
        return "python"
    raw = raw.lower()
    if raw in ("py", "python"):
        return "python"
    if raw in ("ts", "typescript"):
        return "typescript"
    if raw in ("js", "javascript"):
        return "javascript"
    if raw in ("rs", "rust"):
        return "rust"
    if raw in ("sh", "bash"):
        return "bash"
    return "python"


def extract_code_blocks(text: str) -> List[Tuple[str, str]]:
    """
    Возвращает список (lang, code) из всех ```lang ... ``` блоков в тексте.
    Если lang не указан — считаем Python.
    """
    results = []
    for m in _CODE_BLOCK_RE.finditer(text):
        lang = _normalize_lang(m.group("lang"))
        code = m.group("code").strip()
        if code:
            results.append((lang, code))
    return results


# ---------------------------------------------------------------------------
# Запуск инструментов
# ---------------------------------------------------------------------------

async def _run_command(cmd: List[str], cwd: Optional[str] = None, timeout: int = 30) -> Tuple[int, str, str]:
    """Асинхронно запускает подпроцесс, возвращает (returncode, stdout, stderr)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode, stdout.decode("utf-8", errors="replace"), stderr.decode("utf-8", errors="replace")
    except asyncio.TimeoutError:
        logger.warning(f"Command timed out: {' '.join(cmd)}")
        return -1, "", "timeout"
    except FileNotFoundError:
        logger.debug(f"Tool not found: {cmd[0]}")
        return -2, "", f"not_installed: {cmd[0]}"


# --- SEMGREP ---

async def run_semgrep(filepath: str, lang: str) -> List[ValidationIssue]:
    """
    Запускает semgrep с авто-конфигом. Поддерживает Python и TypeScript.
    Нужна установка: pip install semgrep
    """
    issues = []
    if lang not in ("python", "typescript", "javascript"):
        return issues

    returncode, stdout, stderr = await _run_command(
        ["semgrep", "--config=auto", "--json", "--quiet", filepath],
        timeout=60,
    )

    if returncode == -2:  # not installed
        logger.debug("semgrep not installed — skipping")
        return issues

    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        logger.debug(f"semgrep JSON parse error: {stdout[:200]}")
        return issues

    for finding in data.get("results", []):
        severity = finding.get("extra", {}).get("severity", "warning").lower()
        # semgrep severity: ERROR → critical, WARNING → warning, INFO → info
        if severity == "error":
            severity = "critical"
        message = finding.get("extra", {}).get("message", "").strip()
        line = finding.get("start", {}).get("line", 0)
        rule_id = finding.get("check_id", "").split(".")[-1]  # Короткий ID
        fix = finding.get("extra", {}).get("fix", "")
        issues.append(ValidationIssue(
            tool="semgrep",
            severity=severity,
            message=message[:200],
            line=line,
            rule_id=rule_id,
            fix_hint=fix[:100] if fix else "",
        ))

    return issues


# --- BANDIT ---

async def run_bandit(filepath: str) -> List[ValidationIssue]:
    """
    Запускает bandit для Python. Находит: hardcoded passwords, SQL injection,
    subprocess injection, eval(), pickle, weak crypto и т.д.
    Нужна установка: pip install bandit
    """
    issues = []
    returncode, stdout, stderr = await _run_command(
        ["bandit", "-f", "json", "-q", filepath],
        timeout=30,
    )

    if returncode == -2:  # not installed
        logger.debug("bandit not installed — skipping")
        return issues

    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        logger.debug(f"bandit JSON parse error: {stdout[:200]}")
        return issues

    severity_map = {"HIGH": "critical", "MEDIUM": "warning", "LOW": "info"}

    for result in data.get("results", []):
        severity = severity_map.get(result.get("issue_severity", "LOW"), "info")
        confidence = result.get("issue_confidence", "LOW")
        # Пропускаем LOW severity + LOW confidence (спам)
        if severity == "info" and confidence == "LOW":
            continue
        issues.append(ValidationIssue(
            tool="bandit",
            severity=severity,
            message=result.get("issue_text", "").strip()[:200],
            line=result.get("line_number", 0),
            rule_id=result.get("test_id", ""),
            fix_hint=result.get("more_info", "")[:80],
        ))

    return issues


# --- RUFF ---

async def run_ruff(filepath: str) -> List[ValidationIssue]:
    """
    Запускает ruff — ультрабыстрый Python linter (замена flake8 + isort + pyupgrade).
    Нужна установка: pip install ruff
    """
    issues = []
    returncode, stdout, stderr = await _run_command(
        ["ruff", "check", "--output-format=json", filepath],
        timeout=15,
    )

    if returncode == -2:  # not installed
        logger.debug("ruff not installed — skipping")
        return issues

    try:
        results = json.loads(stdout)
    except json.JSONDecodeError:
        logger.debug(f"ruff JSON parse error: {stdout[:200]}")
        return issues

    # Критичные коды: F811 (переопределение), F821 (undefined name), E711/E712 (сравнение None/bool)
    critical_codes = {"F821", "F811", "E711", "E712", "F401", "B006", "B007"}

    for result in results:
        code = result.get("code", "")
        severity = "critical" if code in critical_codes else "info"
        # Пропускаем чисто стилистические замечания E501 (длина строки)
        if code in ("E501", "W291", "W293", "W391"):
            continue
        issues.append(ValidationIssue(
            tool="ruff",
            severity=severity,
            message=result.get("message", "").strip()[:200],
            line=result.get("location", {}).get("row", 0),
            rule_id=code,
        ))

    return issues


# --- CARGO AUDIT (Rust) ---

async def run_cargo_audit(workspace_dir: str) -> List[ValidationIssue]:
    """
    Запускает cargo audit в директории rust_core.
    Проверяет зависимости на CVE из RustSec Advisory Database.
    Нужна установка: cargo install cargo-audit
    """
    issues = []
    rust_core_path = os.path.join(workspace_dir, "rust_core")
    if not os.path.isdir(rust_core_path):
        return issues

    returncode, stdout, stderr = await _run_command(
        ["cargo", "audit", "--json"],
        cwd=rust_core_path,
        timeout=120,
    )

    if returncode == -2:  # cargo not found
        logger.debug("cargo not installed — skipping cargo-audit")
        return issues

    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return issues

    for vuln in data.get("vulnerabilities", {}).get("list", []):
        advisory = vuln.get("advisory", {})
        cvss_score = advisory.get("cvss", {}).get("score", 0.0) if advisory.get("cvss") else 0.0
        severity = "critical" if cvss_score >= 7.0 else "warning"
        issues.append(ValidationIssue(
            tool="cargo-audit",
            severity=severity,
            message=f"{advisory.get('title', 'CVE')}: {advisory.get('description', '')[:150]}",
            rule_id=advisory.get("id", ""),
            fix_hint=f"Обновите {vuln.get('package', {}).get('name', '?')} до {vuln.get('versions', {}).get('patched', ['?'])}",
        ))

    return issues


# ---------------------------------------------------------------------------
# Главный класс валидатора
# ---------------------------------------------------------------------------

class CodeValidator:
    """
    Запускает цепочку статических анализаторов для сгенерированного кода.

    Используется в Pipeline Executor так:
        validator = CodeValidator(workspace_dir, config)
        report = await validator.validate_response(executor_response_text)
        if report.has_blocking_issues():
            # Передать отчёт обратно в Executor для исправления
            fix_prompt = report.format_for_model()
    """

    def __init__(self, workspace_dir: str, config: Optional[Dict] = None):
        self.workspace_dir = workspace_dir
        self.config = config or {}
        # Включённые инструменты (можно отключить через config)
        validator_cfg = self.config.get("code_validator", {})
        self.enabled_tools = set(validator_cfg.get("enabled_tools", ["semgrep", "bandit", "ruff"]))
        self.max_issues_per_tool = validator_cfg.get("max_issues_per_tool", 10)

    async def validate_code_block(self, lang: str, code: str) -> ValidationReport:
        """
        Проверяет один блок кода всеми подходящими инструментами.
        """
        report = ValidationReport(language=lang)
        all_issues: List[ValidationIssue] = []

        # Пишем во временный файл
        suffix_map = {
            "python": ".py",
            "typescript": ".ts",
            "javascript": ".js",
            "rust": ".rs",
            "bash": ".sh",
        }
        suffix = suffix_map.get(lang, ".py")

        with tempfile.NamedTemporaryFile(suffix=suffix, mode="w", encoding="utf-8", delete=False) as f:
            f.write(code)
            tmp_path = f.name

        try:
            tasks = []

            if lang == "python":
                if "semgrep" in self.enabled_tools:
                    tasks.append(run_semgrep(tmp_path, lang))
                if "bandit" in self.enabled_tools:
                    tasks.append(run_bandit(tmp_path))
                if "ruff" in self.enabled_tools:
                    tasks.append(run_ruff(tmp_path))

            elif lang in ("typescript", "javascript"):
                if "semgrep" in self.enabled_tools:
                    tasks.append(run_semgrep(tmp_path, lang))

            elif lang == "rust":
                # cargo-audit проверяет весь манифест, а не отдельный файл
                if "cargo-audit" in self.enabled_tools:
                    tasks.append(run_cargo_audit(self.workspace_dir))

            results = await taskgroup_gather(*tasks, return_exceptions=True)

            for res in results:
                if isinstance(res, Exception):
                    logger.warning(f"Validator tool error: {res}")
                    continue
                all_issues.extend(res[: self.max_issues_per_tool])

        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

        report.issues = all_issues
        report.passed = not report.has_blocking_issues()
        return report

    async def validate_response(self, model_response: str) -> List[ValidationReport]:
        """
        Извлекает все кодовые блоки из ответа модели и проверяет каждый.
        Возвращает список отчётов (по одному на блок кода).
        """
        blocks = extract_code_blocks(model_response)
        if not blocks:
            return []

        tasks = [self.validate_code_block(lang, code) for lang, code in blocks]
        reports = await taskgroup_gather(*tasks, return_exceptions=True)

        valid_reports = []
        for r in reports:
            if isinstance(r, Exception):
                logger.warning(f"validate_code_block error: {r}")
            else:
                valid_reports.append(r)

        return valid_reports

    def build_fix_prompt(self, reports: List[ValidationReport]) -> str:
        """
        Строит промпт для передачи результатов валидации обратно в модель.
        Модель должна исправить все найденные проблемы.
        """
        all_blocking = []
        all_warnings = []

        for report in reports:
            for issue in report.issues:
                if issue.severity.lower() in SEVERITY_BLOCK:
                    all_blocking.append(issue.to_prompt_line())
                elif issue.severity.lower() in SEVERITY_WARN:
                    all_warnings.append(issue.to_prompt_line())

        if not all_blocking and not all_warnings:
            return ""

        parts = ["[СТАТИЧЕСКИЙ АНАЛИЗ ОБНАРУЖИЛ ПРОБЛЕМЫ — ИСПРАВЬ КОД]\n"]

        if all_blocking:
            parts.append(f"🔴 КРИТИЧЕСКИЕ ОШИБКИ ({len(all_blocking)}) — обязательно исправить:")
            parts.extend(f"  {line}" for line in all_blocking)

        if all_warnings:
            parts.append(f"\n🟡 ПРЕДУПРЕЖДЕНИЯ ({len(all_warnings)}) — желательно исправить:")
            parts.extend(f"  {line}" for line in all_warnings)

        parts.append(
            "\nПерепиши код, устранив все перечисленные проблемы. "
            "Верни только исправленные блоки кода в том же формате (```python ... ```)."
        )

        return "\n".join(parts)


# ---------------------------------------------------------------------------
# HTTP-фаззинг через ffuf (отдельный сценарий, не inline)
# ---------------------------------------------------------------------------

async def run_ffuf_api_scan(
    target_url: str = "http://localhost:8765",
    wordlist_path: Optional[str] = None,
    timeout: int = 60,
) -> Dict:
    """
    Запускает ffuf для фаззинга HTTP API эндпоинтов OpenClaw.

    НЕ вызывается inline при генерации кода. Вызывается:
    - Вручную: python -c "import asyncio; from src.code_validator import run_ffuf_api_scan; asyncio.run(run_ffuf_api_scan())"
    - Из CI/CD пайплайна
    - Из тестов с маркером @pytest.mark.fuzzing

    Возвращает dict с найденными эндпоинтами и аномалиями.
    """
    if not wordlist_path:
        # Ищем стандартные wordlists
        candidates = [
            "/usr/share/wordlists/dirb/common.txt",
            "/usr/share/seclists/Discovery/Web-Content/common.txt",
            os.path.join(os.path.dirname(__file__), "..", "data", "wordlist_api.txt"),
        ]
        wordlist_path = next((p for p in candidates if os.path.isfile(p)), None)

    if not wordlist_path:
        return {"status": "skipped", "reason": "wordlist not found"}

    returncode, stdout, stderr = await _run_command(
        [
            "ffuf",
            "-w", wordlist_path,
            "-u", f"{target_url}/FUZZ",
            "-X", "POST",
            "-H", "Content-Type: application/json",
            "-mc", "200,201,400,401,403,500",
            "-json",
            "-t", "10",       # 10 потоков
            "-rate", "50",    # 50 req/sec
            "-timeout", "5",
        ],
        timeout=timeout,
    )

    if returncode == -2:
        return {"status": "skipped", "reason": "ffuf not installed (go install github.com/ffuf/ffuf/v2@latest)"}

    results = []
    for line in stdout.splitlines():
        try:
            obj = json.loads(line)
            if "results" in obj:
                results.extend(obj["results"])
        except json.JSONDecodeError:
            pass

    anomalies = [r for r in results if r.get("status", 200) >= 500]

    return {
        "status": "completed",
        "target": target_url,
        "total_found": len(results),
        "anomalies_5xx": len(anomalies),
        "endpoints": [r.get("url", "") for r in results[:20]],  # первые 20
        "anomaly_urls": [r.get("url", "") for r in anomalies],
    }
