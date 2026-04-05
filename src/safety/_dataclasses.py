"""Shared data classes for the safety guardrails layer."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List


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
