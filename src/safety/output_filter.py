"""OutputSafetyFilter — content safety filtering (zero VRAM).

From: Constitutional AI (arXiv:2212.08073).
"""

from __future__ import annotations

import re
from typing import List

import structlog

from src.safety._dataclasses import SafetyFilterResult
from src.validators.security_auditor import SecurityAuditor

logger = structlog.get_logger(__name__)


class OutputSafetyFilter:
    """Filter unsafe content from LLM outputs.

    Checks:
    - Personal information leakage (emails, phones, addresses)
    - API keys and credentials (via SecurityAuditor)
    - Harmful instructions (violence, illegal activity)
    - Bias and discrimination markers
    - Copyright-sensitive content markers
    """

    _EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b")
    _PHONE = re.compile(
        r"(?:\+?\d{1,3}[\s\-]?)?\(?\d{2,4}\)?[\s\-]?\d{3,4}[\s\-]?\d{2,4}"
    )
    _SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
    _CREDIT_CARD = re.compile(r"\b(?:\d{4}[\s\-]?){3}\d{4}\b")
    _PASSPORT_RU = re.compile(r"\b\d{2}\s?\d{2}\s?\d{6}\b")

    _HARMFUL = re.compile(
        r"(?i)\b(?:how\s+to\s+(?:make|build|create|synthesize)\s+(?:a\s+)?(?:bomb|explosive|weapon|poison|drug)|"
        r"step[\s-]by[\s-]step\s+(?:guide|instructions?)\s+(?:to|for)\s+(?:hack|attack|exploit|break\s+into)|"
        r"как\s+(?:сделать|создать|изготовить|синтезировать)\s+(?:бомбу|взрывчатку|оружие|яд|наркотик)|"
        r"пошаговая\s+инструкция\s+(?:по\s+)?(?:взлому|атаке))\b",
    )

    _BIAS = re.compile(
        r"(?i)\b(?:all\s+(?:men|women|blacks?|whites?|asians?|muslims?|jews?|christians?|gays?|lesbians?)"
        r"\s+(?:are|always|never)|"
        r"(?:все\s+(?:мужчины|женщины|чернокожие|белые|азиаты|мусульмане|евреи|христиане))"
        r"\s+(?:всегда|никогда))\b",
    )

    _COPYRIGHT = re.compile(
        r"(?i)(?:©|copyright\s+\d{4}|all\s+rights\s+reserved|"
        r"licensed\s+under|proprietary\s+and\s+confidential|"
        r"авторское\s+право|все\s+права\s+защищены)",
    )

    _PII_PATTERNS: List[tuple[str, re.Pattern[str]]] = [
        ("email", _EMAIL),
        ("phone_number", _PHONE),
        ("ssn", _SSN),
        ("credit_card", _CREDIT_CARD),
        ("passport_ru", _PASSPORT_RU),
    ]

    def filter(self, text: str) -> SafetyFilterResult:
        """Apply safety filters to output text."""
        violations: List[str] = []

        for label, pat in self._PII_PATTERNS:
            if pat.search(text):
                violations.append(f"pii_{label}")

        if SecurityAuditor.scan_for_leaks(text):
            violations.append("credential_leak")

        if self._HARMFUL.search(text):
            violations.append("harmful_instructions")

        if self._BIAS.search(text):
            violations.append("bias_discrimination")

        if self._COPYRIGHT.search(text):
            violations.append("copyright_content")

        is_safe = len(violations) == 0

        if violations:
            severity = "high" if any(
                v in ("harmful_instructions", "credential_leak") for v in violations
            ) else "medium"
        else:
            severity = "low"

        redacted = self.redact(text) if not is_safe else text

        result = SafetyFilterResult(
            is_safe=is_safe,
            violations=violations,
            redacted_text=redacted,
            severity=severity,
        )
        if not is_safe:
            logger.warning(
                "safety_filter_triggered",
                violation_count=len(violations),
                severity=severity,
                violations=violations,
            )
        return result

    def redact(self, text: str) -> str:
        """Redact unsafe content from text."""
        redacted = text
        for label, pat in self._PII_PATTERNS:
            redacted = pat.sub(f"[REDACTED_{label.upper()}]", redacted)
        redacted = SecurityAuditor.sanitize(redacted)
        if self._HARMFUL.search(redacted):
            redacted = self._HARMFUL.sub("[HARMFUL_CONTENT_REMOVED]", redacted)
        return redacted
