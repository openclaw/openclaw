"""PromptInjectionDefender — multi-layer injection detection (zero VRAM)."""

from __future__ import annotations

import re
from typing import List

import structlog

from src.safety._dataclasses import InjectionAnalysis
from src.validators.security_auditor import SecurityAuditor

logger = structlog.get_logger(__name__)


class PromptInjectionDefender:
    """Advanced prompt injection detection and defense.

    Extends the existing SecurityAuditor with:
    - Multi-layer injection detection
    - Jailbreak attempt detection
    - Indirect injection via tool outputs
    - Encoding-based evasion detection (base64, unicode tricks)
    - Token smuggling detection
    """

    INJECTION_PATTERNS = [
        *SecurityAuditor.PROMPT_INJECTION_PATTERNS,
        re.compile(r"(?i)(?:forget|override|reset)\s+(?:your|all|previous)\s+(?:instructions|rules|prompts?)"),
        re.compile(r"(?i)new\s+(?:system\s+)?instructions?\s*:"),
        re.compile(r"(?i)(?:execute|run|eval)\s*\("),
        re.compile(r"(?i)(?:sudo|chmod|rm\s+-rf|wget|curl)\s"),
        re.compile(r"(?i)<\s*(?:script|img|iframe|object|embed|svg)\b"),
        re.compile(r"(?i)\{\{.*\}\}"),
        re.compile(r"(?i)\$\{.*\}"),
        re.compile(r"(?i)(?:забудь|игнорируй|отмени)\s+(?:все\s+)?(?:свои\s+|предыдущие\s+|прежние\s+)?(?:инструкции|правила|указания)"),
        re.compile(r"(?i)новые\s+инструкции\s*:"),
        re.compile(r"(?i)(?:покажи|выведи|напечатай)\s+(?:свой\s+)?(?:системный\s+)?(?:промпт|промт|инструкции)"),
        re.compile(r"(?i)#{2,}\s*(?:OVERRIDE|SYSTEM|ADMIN|INJECT)\s*#{2,}"),
        re.compile(r"(?i)(?:reveal|show|print|display)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?)"),
        re.compile(r"<\|im_(?:start|end)\|>"),
        re.compile(r"(?i)\bJAILBREAK\b\s*:"),
        re.compile(r"(?i)ignore\s+the\s+above\b"),
        re.compile(r"(?i)\\n\\n(?:Human|System|Assistant)\s*:"),
        re.compile(r"(?i)(?:deceased|dead)\s+(?:grandmother|grandma|mother|father|relative)"),
    ]

    JAILBREAK_PATTERNS = [
        re.compile(r"(?i)(?:DAN|do\s+anything\s+now)\s+mode"),
        re.compile(r"(?i)you\s+are\s+(?:now\s+)?DAN\b"),
        re.compile(r"(?i)\bdo\s+anything\s+now\b"),
        re.compile(r"(?i)(?:jailbreak|unlock|bypass)\s+(?:mode|filter|safety|restrictions?)"),
        re.compile(r"(?i)you\s+(?:can|must|should)\s+(?:now\s+)?(?:ignore|bypass|override)\s+(?:all\s+)?(?:safety|content|ethical)\s+(?:filters?|guidelines?|rules?)"),
        re.compile(r"(?i)pretend\s+.*?(?:no|without)\s+(?:restrictions?|limits?|rules?)"),
        re.compile(r"(?i)\bjailbroken?\b"),
        re.compile(r"(?i)(?:imagine|roleplay|act)\s+(?:as|like)\s+(?:an?\s+)?(?:evil|unrestricted|unfiltered|uncensored)"),
        re.compile(r"(?i)developer\s+mode\b"),
        re.compile(r"(?i)(?:all\s+)?safety\s+is\s+off\b"),
        re.compile(r"(?i)in\s+(?:a\s+)?hypothetical\s+(?:scenario|world)\s+where\s+(?:there\s+are\s+)?no\s+(?:rules|restrictions|limits)"),
        re.compile(r"(?i)act\s+as\s+(?:my\s+)?(?:deceased|dead)\s+(?:grandmother|grandma|relative)"),
        re.compile(r"(?i)(?:have\s+)?no\s+(?:rules|restrictions|limits)\b"),
        re.compile(r"(?i)(?:режим|мод)\s+(?:без\s+ограничений|разработчика|DAN)"),
        re.compile(r"(?i)(?:представь|притворись)\s+(?:что\s+)?(?:ты\s+)?(?:без|нет)\s+(?:ограничений|правил)"),
        re.compile(r"(?i)ты\s+теперь\s+(?:злой|плохой|опасный|evil|без\s+(?:правил|ограничений))"),
    ]

    ENCODING_EVASION_PATTERNS = [
        re.compile(r"(?i)(?:base64|b64)\s*[:\-]\s*[A-Za-z0-9+/=]{20,}"),
        re.compile(r"(?:\\u[0-9a-fA-F]{4}){3,}"),
        re.compile(r"(?:\\x[0-9a-fA-F]{2}){4,}"),
        re.compile(r"[\u200b-\u200f\u2028-\u202f\ufeff]"),
        re.compile(r"(?:%[0-9a-fA-F]{2}){4,}"),
        re.compile(r"(?:&#(?:x[0-9a-fA-F]+|\d+);){3,}"),
    ]

    _TOOL_INJECTION_MARKERS = re.compile(
        r"(?i)(?:SYSTEM|ADMIN|IMPORTANT)\s*:\s*(?:ignore|override|new\s+instructions)",
    )

    STRICTNESS_THRESHOLDS = {
        "low": 0.7,
        "medium": 0.5,
        "high": 0.3,
    }

    def __init__(self, strictness: str = "medium") -> None:
        if strictness not in self.STRICTNESS_THRESHOLDS:
            raise ValueError(f"strictness must be one of {list(self.STRICTNESS_THRESHOLDS)}")
        self.strictness = strictness
        self.threshold = self.STRICTNESS_THRESHOLDS[strictness]

    def analyze(self, text: str, source: str = "user") -> InjectionAnalysis:
        """Comprehensive injection analysis across all layers."""
        matched: List[str] = []
        severity_score = 0.0

        for pat in self.INJECTION_PATTERNS:
            if pat.search(text):
                matched.append(f"injection: {pat.pattern[:60]}")
                severity_score += 0.3

        for pat in self.JAILBREAK_PATTERNS:
            if pat.search(text):
                matched.append(f"jailbreak: {pat.pattern[:60]}")
                severity_score += 0.4

        evasions = self.detect_encoding_evasion(text)
        matched.extend(evasions)
        severity_score += 0.25 * len(evasions)

        if source == "tool":
            if self._TOOL_INJECTION_MARKERS.search(text):
                matched.append("indirect_injection_via_tool_output")
                severity_score += 0.5

        if SecurityAuditor.scan_for_leaks(text):
            matched.append("security_auditor_leak_detected")
            severity_score += 0.2

        confidence = min(severity_score, 1.0)
        is_injection = confidence >= self.threshold

        if confidence >= 0.8:
            severity = "critical"
            action = "block"
        elif confidence >= 0.5:
            severity = "high"
            action = "block"
        elif confidence >= 0.3:
            severity = "medium"
            action = "warn"
        else:
            severity = "low"
            action = "allow"

        result = InjectionAnalysis(
            is_injection=is_injection,
            confidence=round(confidence, 2),
            patterns_matched=matched,
            severity=severity,
            recommended_action=action,
        )
        if is_injection:
            logger.warning(
                "injection_detected",
                severity=severity,
                confidence=result.confidence,
                source=source,
                pattern_count=len(matched),
            )
        return result

    def sanitize_tool_output(self, output: str) -> str:
        """Sanitize tool output to prevent indirect injection."""
        sanitized = re.sub(r"[\u200b-\u200f\u2028-\u202f\ufeff]", "", output)
        sanitized = self._TOOL_INJECTION_MARKERS.sub("[TOOL_OUTPUT_SANITIZED]", sanitized)
        sanitized = SecurityAuditor.sanitize(sanitized)
        return sanitized

    def detect_encoding_evasion(self, text: str) -> List[str]:
        """Detect base64, unicode, and other encoding tricks."""
        flags: List[str] = []
        for pat in self.ENCODING_EVASION_PATTERNS:
            if pat.search(text):
                flags.append(f"encoding_evasion: {pat.pattern[:60]}")
        return flags
