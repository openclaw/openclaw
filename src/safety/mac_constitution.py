"""MAC — Multi-Agent Constitution Learning for OpenClaw v14.0.

Reference:
- Thareja et al., "MAC: Multi-Agent Constitution Learning", arXiv:2603.15968 (2026)

Механика:
- Анализирует историю взаимодействий и выявляет «негласные правила»
  (например: «всегда использовать anyhow для ошибок в Rust»).
- Автоматически дополняет системные промпты секцией [DYNAMIC_RULES].
- Кэширует правила в SuperMemory — промпты не раздуваются при каждом вызове.
- asyncio.TaskGroup для параллельной обработки истории.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import structlog

from src.llm_gateway import route_llm

logger = structlog.get_logger("MAC")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Ключ кэша в SuperMemory
_CACHE_KEY = "mac:dynamic_rules"
# Правила устаревают через 6 часов (TTL в секундах)
_RULES_TTL_SEC = 6 * 3600
# Максимум правил в [DYNAMIC_RULES]
_MAX_RULES = 12
# Минимальная длина записи истории для анализа
_MIN_HISTORY_LEN = 30

# Паттерны "негласных правил" без LLM (эвристика для быстрого извлечения)
_HEURISTIC_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\banyhow\b", re.I),       "В Rust — используй `anyhow` для обработки ошибок"),
    (re.compile(r"\bthiserror\b", re.I),    "В Rust — используй `thiserror` для кастомных типов ошибок"),
    (re.compile(r"\bstructlog\b", re.I),    "Логирование — только через `structlog`, не `print`"),
    (re.compile(r"\basyncio\.TaskGroup\b", re.I), "Параллельные задачи — asyncio.TaskGroup (Python 3.11+)"),
    (re.compile(r"\bpnpm\b", re.I),         "Пакетный менеджер Node.js — pnpm (не npm/yarn)"),
    (re.compile(r"\bvitest\b", re.I),       "Тесты JS/TS — Vitest (не Jest)"),
    (re.compile(r"\boxfmt\b", re.I),        "Форматирование — oxfmt (не prettier/black)"),
    (re.compile(r"\bOpenRouter\b", re.I),   "Инференс — через OpenRouter API (cloud-only)"),
]


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class ConstitutionRule:
    """Одно правило динамической конституции."""
    text: str
    confidence: float = 0.8
    source: str = "heuristic"   # "heuristic" | "llm" | "manual"
    created_at: float = field(default_factory=time.time)


@dataclass
class MACState:
    """Текущее состояние динамических правил."""
    rules: List[ConstitutionRule]
    extracted_at: float
    history_hash: str   # MD5 хэш входной истории (для инвалидации кэша)
    llm_rules_count: int = 0
    heuristic_rules_count: int = 0


# ---------------------------------------------------------------------------
# MAC Engine
# ---------------------------------------------------------------------------

class MACConstitution:
    """Динамическая конституция: перманентное обучение правилам из истории.

    Пример использования:
        mac = MACConstitution()
        rules = await mac.extract_rules(history_entries, config=config)
        enriched = mac.enrich_system_prompt(original_prompt)
    """

    def __init__(
        self,
        model: str = "",
        enabled: bool = True,
    ):
        self.model = model or "google/gemma-3-12b-it:free"
        self.enabled = enabled
        self._state: Optional[MACState] = None
        self._last_refresh: float = 0.0

    # ------------------------------------------------------------------
    # Rule extraction
    # ------------------------------------------------------------------

    def _extract_heuristic_rules(self, text: str) -> List[ConstitutionRule]:
        """Быстрое извлечение правил по паттернам без LLM."""
        found: List[ConstitutionRule] = []
        seen: set[str] = set()
        for pat, rule_text in _HEURISTIC_PATTERNS:
            if pat.search(text) and rule_text not in seen:
                found.append(ConstitutionRule(
                    text=rule_text,
                    confidence=0.9,
                    source="heuristic",
                ))
                seen.add(rule_text)
        return found

    async def _extract_llm_rules(
        self,
        history_chunk: str,
        config: Optional[Dict[str, Any]] = None,
    ) -> List[str]:
        """Вызывает LLM для извлечения неявных правил из фрагмента истории."""
        system = (
            "Ты — аналитик кодовой базы. Прочитай переписку и выпиши "
            "ТОЛЬКО конкретные технические правила, которые применяются неявно. "
            "Формат: JSON-массив строк. Максимум 5 правил. "
            "Игнорируй очевидные вещи. Никаких пояснений вне JSON."
        )
        user = (
            f"История взаимодействий:\n{history_chunk[:2000]}\n\n"
            "Выпиши JSON-массив неявных технических правил."
        )
        try:
            raw = await route_llm(
                user,
                system=system,
                model=self.model,
                task_type="mac_extraction",
                max_tokens=512,
                temperature=0.3,
            )
            raw = (raw or "").strip()
            # Ищем JSON-массив в ответе
            m = re.search(r'\[.*?\]', raw, re.DOTALL)
            if m:
                import json
                items = json.loads(m.group(0))
                return [str(i).strip() for i in items if isinstance(i, str) and len(i) > 10]
        except Exception as e:
            logger.warning("MAC LLM extraction failed (non-fatal)", error=str(e))
        return []

    # ------------------------------------------------------------------
    # Main public API
    # ------------------------------------------------------------------

    async def extract_rules(
        self,
        history_entries: List[str],
        config: Optional[Dict[str, Any]] = None,
        force_refresh: bool = False,
    ) -> MACState:
        """Извлекает правила из истории.

        Возвращает MACState. Если правила актуальны — отдаёт их из кэша.
        Использует asyncio.TaskGroup для параллельного LLM-анализа чанков.
        """
        if not self.enabled:
            return MACState(rules=[], extracted_at=time.time(),
                            history_hash="", llm_rules_count=0, heuristic_rules_count=0)

        # Фильтруем слишком короткие записи
        valid = [e for e in history_entries if len(e.strip()) >= _MIN_HISTORY_LEN]
        combined = "\n---\n".join(valid[:50])  # берём не более 50 записей
        h = hashlib.md5(combined.encode()).hexdigest()[:12]

        # Кэш: если хэш совпадает и не протухло → возвращаем кэш
        if (
            not force_refresh
            and self._state is not None
            and self._state.history_hash == h
            and (time.time() - self._state.extracted_at) < _RULES_TTL_SEC
        ):
            logger.debug("MAC: returning cached rules", count=len(self._state.rules))
            return self._state

        # 1. Эвристика (мгновенно)
        heuristic_rules = self._extract_heuristic_rules(combined)

        # 2. LLM-извлечение (чанки по ~2000 символов, параллельно)
        chunks = [combined[i:i+2000] for i in range(0, min(len(combined), 8000), 2000)]
        llm_texts: list[list[str]] = [[] for _ in chunks]

        if chunks:
            try:
                async with asyncio.TaskGroup() as tg:
                    tasks = [
                        tg.create_task(self._extract_llm_rules(chunk, config))
                        for chunk in chunks
                    ]
                for i, t in enumerate(tasks):
                    llm_texts[i] = t.result()
            except* Exception as eg:
                logger.warning("MAC TaskGroup partial failure", errors=[str(e) for e in eg.exceptions])

        # Собираем LLM-правила, дедупликуем
        seen_texts: set[str] = {r.text for r in heuristic_rules}
        llm_rules: List[ConstitutionRule] = []
        for chunk_results in llm_texts:
            for text in chunk_results:
                if text not in seen_texts:
                    llm_rules.append(ConstitutionRule(
                        text=text, confidence=0.75, source="llm",
                    ))
                    seen_texts.add(text)

        all_rules = heuristic_rules + llm_rules
        # Сортируем по confidence DESC, ограничиваем
        all_rules.sort(key=lambda r: -r.confidence)
        all_rules = all_rules[:_MAX_RULES]

        self._state = MACState(
            rules=all_rules,
            extracted_at=time.time(),
            history_hash=h,
            llm_rules_count=len(llm_rules),
            heuristic_rules_count=len(heuristic_rules),
        )
        logger.info(
            "MAC rules extracted",
            total=len(all_rules),
            heuristic=len(heuristic_rules),
            llm=len(llm_rules),
        )
        return self._state

    def load_from_memory(self, supermemory: Any) -> bool:
        """Загружает кэшированные правила из SuperMemory. Возвращает True если успех."""
        if supermemory is None:
            return False
        try:
            results = supermemory.recall(_CACHE_KEY, top_k=1)
            if not results:
                return False
            import json
            data = json.loads(results[0].content)
            rules = [ConstitutionRule(**r) for r in data.get("rules", [])]
            self._state = MACState(
                rules=rules,
                extracted_at=data.get("extracted_at", 0.0),
                history_hash=data.get("history_hash", ""),
                llm_rules_count=data.get("llm_rules_count", 0),
                heuristic_rules_count=data.get("heuristic_rules_count", 0),
            )
            return True
        except Exception as e:
            logger.debug("MAC memory load failed (non-fatal)", error=str(e))
            return False

    def save_to_memory(self, supermemory: Any) -> None:
        """Сохраняет текущие правила в SuperMemory."""
        if supermemory is None or self._state is None:
            return
        try:
            import json
            from dataclasses import asdict
            data = {
                "rules": [asdict(r) for r in self._state.rules],
                "extracted_at": self._state.extracted_at,
                "history_hash": self._state.history_hash,
                "llm_rules_count": self._state.llm_rules_count,
                "heuristic_rules_count": self._state.heuristic_rules_count,
            }
            supermemory.store(
                key=_CACHE_KEY,
                content=json.dumps(data, ensure_ascii=False),
                importance=0.6,
                source="mac_constitution",
                tier="warm",
            )
            logger.debug("MAC rules saved to SuperMemory", count=len(self._state.rules))
        except Exception as e:
            logger.warning("MAC memory save failed (non-fatal)", error=str(e))

    # ------------------------------------------------------------------
    # System prompt enrichment
    # ------------------------------------------------------------------

    def enrich_system_prompt(self, original: str) -> str:
        """Инжектирует [DYNAMIC_RULES] в конец system-промпта.

        Если правил нет или MAC не активен → возвращает исходный промпт без изменений.
        """
        if not self.enabled or not self._state or not self._state.rules:
            return original

        rules_block = "\n".join(
            f"- {r.text}" for r in self._state.rules[:_MAX_RULES]
        )
        section = (
            "\n\n[DYNAMIC_RULES — усвоенные правила проекта]\n"
            f"{rules_block}"
        )
        # Не добавляем если блок уже есть (идемпотентность)
        if "[DYNAMIC_RULES" in original:
            return original
        return original + section

    @property
    def rules_count(self) -> int:
        if self._state is None:
            return 0
        return len(self._state.rules)

    @property
    def current_rules(self) -> List[ConstitutionRule]:
        if self._state is None:
            return []
        return list(self._state.rules)
