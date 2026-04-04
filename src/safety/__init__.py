"""Safety modules — hallucination control, prompt injection defense, etc."""

from src.safety._dataclasses import (
    HallucinationResult,
    InjectionAnalysis,
    SafetyFilterResult,
    TruthfulnessResult,
)
from src.safety.audit_logger import SafetyAuditLogger
from src.safety.hallucination import MARCHProtocol
from src.safety.hallucination_detector import HallucinationDetector
from src.safety.injection import PromptInjectionDefender
from src.safety.output_filter import OutputSafetyFilter
from src.safety.truthfulness import TruthfulnessScorer

__all__ = [
    "HallucinationDetector",
    "HallucinationResult",
    "InjectionAnalysis",
    "MARCHProtocol",
    "OutputSafetyFilter",
    "PromptInjectionDefender",
    "SafetyAuditLogger",
    "SafetyFilterResult",
    "TruthfulnessResult",
    "TruthfulnessScorer",
]
