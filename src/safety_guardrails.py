"""
Safety Guardrails Module — heuristic-only safety layer (zero VRAM).

Implements detection and filtering inspired by:
- Constitutional AI (arXiv:2212.08073)
- TruthRL: Incentivizing Truthful LLMs (2025)
- FAPO: Flawed-Aware Policy Optimization

All checks are pure regex / heuristic — no LLM calls.
Compatible with the existing SecurityAuditor in src/security_auditor.py.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import structlog

from src.security_auditor import SecurityAuditor

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class HallucinationResult:
    """Result of hallucination detection."""

    confidence: float  # 0.0 – 1.0
    flags: List[str] = field(default_factory=list)
    suspicious_claims: List[str] = field(default_factory=list)
    overall_risk: str = "low"  # low / medium / high


@dataclass
class InjectionAnalysis:
    """Result of prompt-injection analysis."""

    is_injection: bool
    confidence: float
    patterns_matched: List[str] = field(default_factory=list)
    severity: str = "low"  # low / medium / high / critical
    recommended_action: str = "allow"  # allow / warn / block


@dataclass
class SafetyFilterResult:
    """Result of output safety filtering."""

    is_safe: bool
    violations: List[str] = field(default_factory=list)
    redacted_text: str = ""
    severity: str = "low"


@dataclass
class TruthfulnessResult:
    """Result of truthfulness scoring."""

    score: float  # 0.0 – 1.0
    hedging_score: float = 0.0
    source_citation_score: float = 0.0
    uncertainty_acknowledgment: float = 0.0
    flags: List[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# 1. HallucinationDetector
# ---------------------------------------------------------------------------


class HallucinationDetector:
    """Detect potential hallucinations in LLM output.

    From: TruthRL: Incentivizing Truthful LLMs (2025)
        + FAPO: Flawed-Aware Policy Optimization.

    Detection heuristics (no LLM needed):
    - Confidence hedging: excessive "definitely", "certainly" without evidence
    - Fake references: citations that look plausible but are fabricated
    - Inconsistency: contradictions within the same response
    - Statistical anomalies: made-up numbers/dates
    - Knowledge boundary: claims about events after training cutoff
    """

    # Overconfidence markers (EN + RU)
    _OVERCONFIDENCE_MARKERS = re.compile(
        r"\b(?:definitely|certainly|absolutely|undoubtedly|unquestionably|"
        r"without a doubt|100\s*%|guaranteed|proven fact|"
        # Russian equivalents
        r"однозначно|безусловно|абсолютно точно|несомненно|гарантированно|"
        r"доказанный факт|стопроцентно)\b",
        re.IGNORECASE,
    )

    # Hedging phrases that *offset* overconfidence
    _HEDGE_MARKERS = re.compile(
        r"\b(?:I think|I believe|probably|likely|possibly|approximately|"
        r"it seems|as far as I know|I'm not sure|"
        r"я думаю|вероятно|возможно|приблизительно|насколько я знаю|"
        r"не уверен|не уверена|скорее всего|по-видимому)\b",
        re.IGNORECASE,
    )

    # Fabricated-looking citations: "Author et al., YYYY" or "Journal of X (YYYY)"
    _FAKE_REFERENCE = re.compile(
        r"(?:[A-Z][a-z]+(?:\s+(?:et\s+al\.?|and\s+[A-Z][a-z]+))"
        r"[,;]?\s*\(?\d{4}\)?)",
    )

    # Suspicious "Journal of …" or "International Conference on …"
    _JOURNAL_PATTERN = re.compile(
        r"(?:Journal of|Proceedings of|International Conference on|"
        r"Annual Review of|IEEE|ACM)\s+[A-Z][A-Za-z\s&]+",
    )

    # Contradiction pairs (simplified)
    _CONTRADICTION_PAIRS: List[tuple[re.Pattern[str], re.Pattern[str]]] = [
        (re.compile(r"\bis\s+true\b", re.I), re.compile(r"\bis\s+false\b", re.I)),
        (re.compile(r"\bis\s+correct\b", re.I), re.compile(r"\bis\s+incorrect\b", re.I)),
        (re.compile(r"\bincreased\b", re.I), re.compile(r"\bdecreased\b", re.I)),
        (re.compile(r"\byes\b", re.I), re.compile(r"\bno\b", re.I)),
        (re.compile(r"\bверно\b", re.I), re.compile(r"\bневерно\b", re.I)),
        (re.compile(r"\bувеличил(?:ся|ась|ось)?\b", re.I), re.compile(r"\bуменьшил(?:ся|ась|ось)?\b", re.I)),
    ]

    # Suspiciously precise large numbers (e.g. "exactly 1,234,567")
    _SUSPICIOUS_NUMBER = re.compile(
        r"\b(?:exactly|precisely|ровно|точно)\s+"
        r"[\d,]{5,}",
        re.IGNORECASE,
    )

    # Very round numbers used as statistics
    _ROUND_STAT = re.compile(
        r"\b(\d+(?:,000){2,})\b"
        r"|(?:\b(\d{2,})%\b)"
    )

    # Date references — matches month names and ISO-style dates
    _DATE_PATTERN = re.compile(
        r"\b(?:January|February|March|April|May|June|July|August|September|"
        r"October|November|December|"
        r"января|февраля|марта|апреля|мая|июня|июля|августа|сентября|"
        r"октября|ноября|декабря)\s+\d{1,2},?\s+(\d{4})\b"
        r"|\b(\d{4})-(\d{2})-(\d{2})\b",
    )

    def __init__(self, training_cutoff_date: str = "2025-10-01") -> None:
        self.training_cutoff = datetime.strptime(training_cutoff_date, "%Y-%m-%d").replace(
            tzinfo=timezone.utc
        )

    def detect(self, response: str, prompt: str = "") -> HallucinationResult:
        """Run all hallucination heuristics and return an aggregate result."""
        flags: List[str] = []
        claims: List[str] = []

        overconf = self._check_overconfidence(response)
        flags.extend(overconf)

        fakes = self._check_fake_references(response)
        flags.extend(fakes)
        claims.extend(fakes)

        inconsistencies = self._check_internal_consistency(response)
        flags.extend(inconsistencies)

        numbers = self._check_suspicious_numbers(response)
        flags.extend(numbers)
        claims.extend(numbers)

        temporal = self._check_temporal_claims(response)
        flags.extend(temporal)
        claims.extend(temporal)

        confidence = min(len(flags) / 5.0, 1.0)

        if confidence >= 0.6:
            risk = "high"
        elif confidence >= 0.3:
            risk = "medium"
        else:
            risk = "low"

        result = HallucinationResult(
            confidence=round(confidence, 2),
            flags=flags,
            suspicious_claims=claims,
            overall_risk=risk,
        )
        if flags:
            logger.info(
                "hallucination_check",
                risk=risk,
                flag_count=len(flags),
                confidence=result.confidence,
            )
        return result

    # -- Private heuristic helpers ------------------------------------------

    def _check_overconfidence(self, text: str) -> List[str]:
        """Flag overconfident claims that lack hedging."""
        overconf_matches = self._OVERCONFIDENCE_MARKERS.findall(text)
        hedge_matches = self._HEDGE_MARKERS.findall(text)

        if overconf_matches and len(overconf_matches) > len(hedge_matches):
            return [
                f"overconfidence: '{m}' without sufficient hedging"
                for m in overconf_matches[: len(overconf_matches) - len(hedge_matches)]
            ]
        return []

    def _check_fake_references(self, text: str) -> List[str]:
        """Flag citations that could be fabricated."""
        flags: List[str] = []
        refs = self._FAKE_REFERENCE.findall(text)
        journals = self._JOURNAL_PATTERN.findall(text)

        # If there are author-style refs but no actual URLs/DOIs, flag them
        if refs and "doi.org" not in text.lower() and "arxiv.org" not in text.lower():
            for ref in refs[:3]:
                flags.append(f"unverifiable_reference: '{ref}'")

        if journals and "doi.org" not in text.lower():
            for j in journals[:2]:
                flags.append(f"unverifiable_journal: '{j}'")

        return flags

    def _check_internal_consistency(self, text: str) -> List[str]:
        """Detect contradictory statements in the same response."""
        flags: List[str] = []
        sentences = re.split(r"[.!?]\s+", text)
        if len(sentences) < 2:
            return flags

        for pat_a, pat_b in self._CONTRADICTION_PAIRS:
            has_a = any(pat_a.search(s) for s in sentences)
            has_b = any(pat_b.search(s) for s in sentences)
            if has_a and has_b:
                flags.append(
                    f"contradiction: both '{pat_a.pattern}' and "
                    f"'{pat_b.pattern}' found"
                )
        return flags

    def _check_suspicious_numbers(self, text: str) -> List[str]:
        """Flag suspiciously precise or round numbers."""
        flags: List[str] = []
        for m in self._SUSPICIOUS_NUMBER.finditer(text):
            flags.append(f"suspicious_precision: '{m.group().strip()}'")
        return flags

    def _check_temporal_claims(self, text: str) -> List[str]:
        """Flag claims about events after the training cutoff."""
        flags: List[str] = []
        for m in self._DATE_PATTERN.finditer(text):
            groups = m.groups()
            # Extract year from either named-month or ISO form
            year_str = groups[0] or groups[1]
            if not year_str:
                continue
            try:
                year = int(year_str)
            except (ValueError, TypeError):
                continue
            if year > self.training_cutoff.year:
                flags.append(f"post_cutoff_date: '{m.group().strip()}'")
            elif year == self.training_cutoff.year:
                # For ISO dates, also check month
                month_str = groups[2] if groups[2] else None
                if month_str:
                    try:
                        month = int(month_str)
                        if month > self.training_cutoff.month:
                            flags.append(f"post_cutoff_date: '{m.group().strip()}'")
                    except (ValueError, TypeError):
                        pass
        return flags


# ---------------------------------------------------------------------------
# 2. PromptInjectionDefender
# ---------------------------------------------------------------------------


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
        re.compile(r"(?i)\{\{.*\}\}"),  # template injection
        re.compile(r"(?i)\$\{.*\}"),  # expression injection
        # Russian injection phrases
        re.compile(r"(?i)(?:забудь|игнорируй|отмени)\s+(?:все\s+)?(?:предыдущие|прежние)\s+(?:инструкции|правила|указания)"),
        re.compile(r"(?i)новые\s+инструкции\s*:"),
        re.compile(r"(?i)(?:покажи|выведи|напечатай)\s+(?:свой\s+)?(?:системный\s+)?(?:промпт|промт|инструкции)"),
    ]

    JAILBREAK_PATTERNS = [
        re.compile(r"(?i)(?:DAN|do\s+anything\s+now)\s+mode"),
        re.compile(r"(?i)(?:jailbreak|unlock|bypass)\s+(?:mode|filter|safety|restrictions?)"),
        re.compile(r"(?i)you\s+(?:can|must|should)\s+(?:now\s+)?(?:ignore|bypass|override)\s+(?:all\s+)?(?:safety|content|ethical)\s+(?:filters?|guidelines?|rules?)"),
        re.compile(r"(?i)pretend\s+(?:you\s+(?:are|have)\s+)?(?:no|without)\s+(?:restrictions?|limits?|rules?)"),
        re.compile(r"(?i)(?:imagine|roleplay|act)\s+(?:as|like)\s+(?:an?\s+)?(?:evil|unrestricted|unfiltered|uncensored)"),
        re.compile(r"(?i)developer\s+mode\s+(?:enabled|on|activated)"),
        re.compile(r"(?i)in\s+(?:a\s+)?hypothetical\s+(?:scenario|world)\s+where\s+(?:there\s+are\s+)?no\s+(?:rules|restrictions|limits)"),
        # Russian jailbreak
        re.compile(r"(?i)(?:режим|мод)\s+(?:без\s+ограничений|разработчика|DAN)"),
        re.compile(r"(?i)(?:представь|притворись)\s+(?:что\s+)?(?:ты\s+)?(?:без|нет)\s+(?:ограничений|правил)"),
    ]

    ENCODING_EVASION_PATTERNS = [
        re.compile(r"(?i)(?:base64|b64)\s*[:\-]\s*[A-Za-z0-9+/=]{20,}"),
        re.compile(r"(?:\\u[0-9a-fA-F]{4}){3,}"),  # unicode escape sequences
        re.compile(r"(?:\\x[0-9a-fA-F]{2}){4,}"),  # hex escape sequences
        re.compile(r"[\u200b-\u200f\u2028-\u202f\ufeff]"),  # zero-width / invisible chars
        re.compile(r"(?:%[0-9a-fA-F]{2}){4,}"),  # URL-encoded payloads
        re.compile(r"(?:&#(?:x[0-9a-fA-F]+|\d+);){3,}"),  # HTML entity encoding
    ]

    # Indirect injection markers in tool/API output
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

        # Layer 1: classic injection patterns
        for pat in self.INJECTION_PATTERNS:
            if pat.search(text):
                matched.append(f"injection: {pat.pattern[:60]}")
                severity_score += 0.3

        # Layer 2: jailbreak patterns
        for pat in self.JAILBREAK_PATTERNS:
            if pat.search(text):
                matched.append(f"jailbreak: {pat.pattern[:60]}")
                severity_score += 0.4

        # Layer 3: encoding evasion
        evasions = self.detect_encoding_evasion(text)
        matched.extend(evasions)
        severity_score += 0.25 * len(evasions)

        # Layer 4: indirect injection (tool output)
        if source == "tool":
            if self._TOOL_INJECTION_MARKERS.search(text):
                matched.append("indirect_injection_via_tool_output")
                severity_score += 0.5

        # Layer 5: existing SecurityAuditor check
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
        sanitized = output

        # Strip invisible / zero-width characters
        sanitized = re.sub(r"[\u200b-\u200f\u2028-\u202f\ufeff]", "", sanitized)

        # Neutralise embedded instruction markers
        sanitized = self._TOOL_INJECTION_MARKERS.sub("[TOOL_OUTPUT_SANITIZED]", sanitized)

        # Also delegate to SecurityAuditor for credential stripping
        sanitized = SecurityAuditor.sanitize(sanitized)

        return sanitized

    def detect_encoding_evasion(self, text: str) -> List[str]:
        """Detect base64, unicode, and other encoding tricks."""
        flags: List[str] = []
        for pat in self.ENCODING_EVASION_PATTERNS:
            if pat.search(text):
                flags.append(f"encoding_evasion: {pat.pattern[:60]}")
        return flags


# ---------------------------------------------------------------------------
# 3. OutputSafetyFilter
# ---------------------------------------------------------------------------


class OutputSafetyFilter:
    """Filter unsafe content from LLM outputs.

    From: Constitutional AI (arXiv:2212.08073)

    Checks:
    - Personal information leakage (emails, phones, addresses)
    - API keys and credentials (via SecurityAuditor)
    - Harmful instructions (violence, illegal activity)
    - Bias and discrimination markers
    - Copyright-sensitive content markers
    """

    # PII patterns
    _EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b")
    _PHONE = re.compile(
        r"(?:\+?\d{1,3}[\s\-]?)?\(?\d{2,4}\)?[\s\-]?\d{3,4}[\s\-]?\d{2,4}"
    )
    _SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
    _CREDIT_CARD = re.compile(r"\b(?:\d{4}[\s\-]?){3}\d{4}\b")
    _PASSPORT_RU = re.compile(r"\b\d{2}\s?\d{2}\s?\d{6}\b")

    # Harmful instruction markers (EN + RU)
    _HARMFUL = re.compile(
        r"(?i)\b(?:how\s+to\s+(?:make|build|create|synthesize)\s+(?:a\s+)?(?:bomb|explosive|weapon|poison|drug)|"
        r"step[\s-]by[\s-]step\s+(?:guide|instructions?)\s+(?:to|for)\s+(?:hack|attack|exploit|break\s+into)|"
        r"как\s+(?:сделать|создать|изготовить|синтезировать)\s+(?:бомбу|взрывчатку|оружие|яд|наркотик)|"
        r"пошаговая\s+инструкция\s+(?:по\s+)?(?:взлому|атаке))\b",
    )

    # Bias / discrimination markers
    _BIAS = re.compile(
        r"(?i)\b(?:all\s+(?:men|women|blacks?|whites?|asians?|muslims?|jews?|christians?|gays?|lesbians?)"
        r"\s+(?:are|always|never)|"
        r"(?:все\s+(?:мужчины|женщины|чернокожие|белые|азиаты|мусульмане|евреи|христиане))"
        r"\s+(?:всегда|никогда))\b",
    )

    # Copyright-sensitive markers
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

        # PII checks
        for label, pat in self._PII_PATTERNS:
            if pat.search(text):
                violations.append(f"pii_{label}")

        # Credential leaks via SecurityAuditor
        if SecurityAuditor.scan_for_leaks(text):
            violations.append("credential_leak")

        # Harmful content
        if self._HARMFUL.search(text):
            violations.append("harmful_instructions")

        # Bias
        if self._BIAS.search(text):
            violations.append("bias_discrimination")

        # Copyright
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

        # Redact PII
        for label, pat in self._PII_PATTERNS:
            redacted = pat.sub(f"[REDACTED_{label.upper()}]", redacted)

        # Delegate credential redaction to SecurityAuditor
        redacted = SecurityAuditor.sanitize(redacted)

        # Block harmful content
        if self._HARMFUL.search(redacted):
            redacted = self._HARMFUL.sub("[HARMFUL_CONTENT_REMOVED]", redacted)

        return redacted


# ---------------------------------------------------------------------------
# 4. TruthfulnessScorer
# ---------------------------------------------------------------------------


class TruthfulnessScorer:
    """Score response truthfulness using heuristic signals.

    From: TruthRL (2025)

    Signals:
    - Hedge appropriately: uses "I think", "likely" for uncertain claims
    - Acknowledges limitations: "I don't know", "I'm not sure"
    - Provides sources: mentions where info comes from
    - Avoids absolute statements without evidence
    - Consistent with known facts (simple factual checks)
    """

    _HEDGE_PHRASES = re.compile(
        r"\b(?:I think|I believe|probably|likely|possibly|perhaps|approximately|roughly|"
        r"it seems|as far as I know|to my knowledge|"
        r"я думаю|вероятно|возможно|приблизительно|насколько я знаю|"
        r"по-видимому|скорее всего|примерно)\b",
        re.IGNORECASE,
    )

    _UNCERTAINTY_PHRASES = re.compile(
        r"(?i)\b(?:I don't know|I'm not sure|I'm uncertain|I cannot confirm|"
        r"I'm not confident|this may be incorrect|"
        r"я не знаю|не уверен|не уверена|не могу подтвердить|"
        r"это может быть неточно|точно не знаю)\b",
    )

    _SOURCE_INDICATORS = re.compile(
        r"(?i)(?:according to|based on|source:|as (?:reported|stated|noted) (?:by|in)|"
        r"cited in|reference:|see also|"
        r"(?:https?://|doi\.org/|arxiv\.org/|wikipedia\.org/)|"
        r"согласно|на основании|источник:|как\s+(?:сообщает|указано|отмечено)\s+в)",
    )

    _ABSOLUTE_STATEMENTS = re.compile(
        r"\b(?:always|never|every|none|all|impossible|"
        r"всегда|никогда|каждый|ни один|все|невозможно)\b",
        re.IGNORECASE,
    )

    def score(self, response: str, prompt: str = "") -> TruthfulnessResult:
        """Score truthfulness of a response on 0-1 scale."""
        if not response.strip():
            return TruthfulnessResult(score=0.5, flags=["empty_response"])

        flags: List[str] = []
        word_count = max(len(response.split()), 1)

        # Hedging score: proportion of hedging relative to length
        hedge_count = len(self._HEDGE_PHRASES.findall(response))
        hedging_score = min(hedge_count / max(word_count / 50, 1), 1.0)

        # Uncertainty acknowledgment
        unc_count = len(self._UNCERTAINTY_PHRASES.findall(response))
        uncertainty_score = min(unc_count / max(word_count / 100, 1), 1.0)

        # Source citation score
        source_count = len(self._SOURCE_INDICATORS.findall(response))
        source_score = min(source_count / max(word_count / 80, 1), 1.0)

        # Penalty for absolute statements
        absolute_count = len(self._ABSOLUTE_STATEMENTS.findall(response))
        absolute_density = absolute_count / max(word_count / 30, 1)

        if hedge_count == 0 and absolute_count > 2:
            flags.append("no_hedging_with_absolutes")
        if source_count == 0 and word_count > 100:
            flags.append("no_sources_in_long_response")
        if unc_count > 0:
            flags.append("acknowledges_uncertainty")

        # Composite score: reward hedging/sources/uncertainty, penalise absolutes
        score = (
            0.30 * hedging_score
            + 0.25 * source_score
            + 0.25 * uncertainty_score
            + 0.20 * max(1.0 - absolute_density, 0.0)
        )
        # Baseline of 0.3 for any non-empty response
        score = min(0.3 + 0.7 * score, 1.0)

        return TruthfulnessResult(
            score=round(score, 2),
            hedging_score=round(hedging_score, 2),
            source_citation_score=round(source_score, 2),
            uncertainty_acknowledgment=round(uncertainty_score, 2),
            flags=flags,
        )


# ---------------------------------------------------------------------------
# 5. SafetyAuditLogger
# ---------------------------------------------------------------------------


class SafetyAuditLogger:
    """Log all safety-relevant events for audit trail.

    Maintains a JSONL audit log for:
    - Injection attempts (detected and blocked)
    - Hallucination flags
    - Content filtering events
    - Credential leak attempts
    - Safety policy violations
    """

    VALID_SEVERITIES = ("low", "medium", "high", "critical")

    def __init__(self, log_dir: str = "training_data/safety_audit") -> None:
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self._log_file = self.log_dir / "audit.jsonl"

    def log_event(
        self,
        event_type: str,
        severity: str,
        details: Dict[str, Any],
    ) -> None:
        """Append a safety event to the audit log."""
        if severity not in self.VALID_SEVERITIES:
            raise ValueError(f"severity must be one of {self.VALID_SEVERITIES}")

        record = {
            "id": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event_type": event_type,
            "severity": severity,
            "details": details,
        }
        with open(self._log_file, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")

        logger.info(
            "safety_audit_event",
            event_type=event_type,
            severity=severity,
        )

    def get_summary(self, last_n_hours: int = 24) -> Dict[str, Any]:
        """Return a summary of events in the last *last_n_hours* hours."""
        cutoff = datetime.now(timezone.utc).timestamp() - last_n_hours * 3600
        counts: Dict[str, int] = {}
        severity_counts: Dict[str, int] = {}
        total = 0

        if not self._log_file.exists():
            return {"total_events": 0, "by_type": {}, "by_severity": {}}

        with open(self._log_file, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = record.get("timestamp", "")
                try:
                    event_time = datetime.fromisoformat(ts).timestamp()
                except (ValueError, TypeError):
                    continue
                if event_time < cutoff:
                    continue
                total += 1
                etype = record.get("event_type", "unknown")
                sev = record.get("severity", "unknown")
                counts[etype] = counts.get(etype, 0) + 1
                severity_counts[sev] = severity_counts.get(sev, 0) + 1

        return {
            "total_events": total,
            "by_type": counts,
            "by_severity": severity_counts,
        }
