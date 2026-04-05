"""HallucinationDetector — heuristic hallucination detection (zero VRAM).

From: TruthRL: Incentivizing Truthful LLMs (2025)
    + FAPO: Flawed-Aware Policy Optimization.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import List

import structlog

from src.safety._dataclasses import HallucinationResult

logger = structlog.get_logger(__name__)


class HallucinationDetector:
    """Detect potential hallucinations in LLM output.

    Detection heuristics (no LLM needed):
    - Confidence hedging: excessive "definitely", "certainly" without evidence
    - Fake references: citations that look plausible but are fabricated
    - Inconsistency: contradictions within the same response
    - Statistical anomalies: made-up numbers/dates
    - Knowledge boundary: claims about events after training cutoff
    """

    _OVERCONFIDENCE_MARKERS = re.compile(
        r"\b(?:definitely|certainly|absolutely|undoubtedly|unquestionably|"
        r"without a doubt|100\s*%|guaranteed|proven fact|"
        r"однозначно|безусловно|абсолютно точно|несомненно|гарантированно|"
        r"доказанный факт|стопроцентно)\b",
        re.IGNORECASE,
    )

    _HEDGE_MARKERS = re.compile(
        r"\b(?:I think|I believe|probably|likely|possibly|approximately|"
        r"it seems|as far as I know|I'm not sure|"
        r"я думаю|вероятно|возможно|приблизительно|насколько я знаю|"
        r"не уверен|не уверена|скорее всего|по-видимому)\b",
        re.IGNORECASE,
    )

    _FAKE_REFERENCE = re.compile(
        r"(?:[A-Z][a-z]+(?:\s+(?:et\s+al\.?|and\s+[A-Z][a-z]+))"
        r"[,;]?\s*\(?\d{4}\)?)",
    )

    _JOURNAL_PATTERN = re.compile(
        r"(?:Journal of|Proceedings of|International Conference on|"
        r"Annual Review of|IEEE|ACM)\s+[A-Z][A-Za-z\s&]+",
    )

    _CONTRADICTION_PAIRS: List[tuple[re.Pattern[str], re.Pattern[str]]] = [
        (re.compile(r"\bis\s+true\b", re.I), re.compile(r"\bis\s+false\b", re.I)),
        (re.compile(r"\bis\s+correct\b", re.I), re.compile(r"\bis\s+incorrect\b", re.I)),
        (re.compile(r"\bincreased\b", re.I), re.compile(r"\bdecreased\b", re.I)),
        (re.compile(r"\byes\b", re.I), re.compile(r"\bno\b", re.I)),
        (re.compile(r"\bверно\b", re.I), re.compile(r"\bневерно\b", re.I)),
        (re.compile(r"\bувеличил(?:ся|ась|ось)?\b", re.I), re.compile(r"\bуменьшил(?:ся|ась|ось)?\b", re.I)),
    ]

    _SUSPICIOUS_NUMBER = re.compile(
        r"\b(?:exactly|precisely|ровно|точно)\s+"
        r"[\d,]{5,}",
        re.IGNORECASE,
    )

    _ROUND_STAT = re.compile(
        r"\b(\d+(?:,000){2,})\b"
        r"|(?:\b(\d{2,})%\b)"
    )

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

    def _check_overconfidence(self, text: str) -> List[str]:
        overconf_matches = self._OVERCONFIDENCE_MARKERS.findall(text)
        hedge_matches = self._HEDGE_MARKERS.findall(text)
        if overconf_matches and len(overconf_matches) > len(hedge_matches):
            return [
                f"overconfidence: '{m}' without sufficient hedging"
                for m in overconf_matches[: len(overconf_matches) - len(hedge_matches)]
            ]
        return []

    def _check_fake_references(self, text: str) -> List[str]:
        flags: List[str] = []
        refs = self._FAKE_REFERENCE.findall(text)
        journals = self._JOURNAL_PATTERN.findall(text)
        if refs and "doi.org" not in text.lower() and "arxiv.org" not in text.lower():
            for ref in refs[:3]:
                flags.append(f"unverifiable_reference: '{ref}'")
        if journals and "doi.org" not in text.lower():
            for j in journals[:2]:
                flags.append(f"unverifiable_journal: '{j}'")
        return flags

    def _check_internal_consistency(self, text: str) -> List[str]:
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
        flags: List[str] = []
        for m in self._SUSPICIOUS_NUMBER.finditer(text):
            flags.append(f"suspicious_precision: '{m.group().strip()}'")
        return flags

    def _check_temporal_claims(self, text: str) -> List[str]:
        flags: List[str] = []
        for m in self._DATE_PATTERN.finditer(text):
            groups = m.groups()
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
                month_str = groups[2] if groups[2] else None
                if month_str:
                    try:
                        month = int(month_str)
                        if month > self.training_cutoff.month:
                            flags.append(f"post_cutoff_date: '{m.group().strip()}'")
                    except (ValueError, TypeError):
                        pass
        return flags
