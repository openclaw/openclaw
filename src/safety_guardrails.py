"""
Safety Guardrails Module — backward-compatible re-export shim.

All classes have been refactored into src/safety/ submodules:
  - src/safety/_dataclasses.py   (HallucinationResult, InjectionAnalysis, etc.)
  - src/safety/hallucination_detector.py  (HallucinationDetector)
  - src/safety/injection.py       (PromptInjectionDefender)
  - src/safety/output_filter.py   (OutputSafetyFilter)
  - src/safety/truthfulness.py    (TruthfulnessScorer)
  - src/safety/audit_logger.py    (SafetyAuditLogger)

This file re-exports all public names so existing imports keep working.
"""

from src.safety._dataclasses import (  # noqa: F401
    HallucinationResult,
    InjectionAnalysis,
    SafetyFilterResult,
    TruthfulnessResult,
)
from src.safety.audit_logger import SafetyAuditLogger  # noqa: F401
from src.safety.hallucination_detector import HallucinationDetector  # noqa: F401
from src.safety.injection import PromptInjectionDefender  # noqa: F401
from src.safety.output_filter import OutputSafetyFilter  # noqa: F401
from src.safety.truthfulness import TruthfulnessScorer  # noqa: F401

__all__ = [
    "HallucinationDetector",
    "HallucinationResult",
    "InjectionAnalysis",
    "OutputSafetyFilter",
    "PromptInjectionDefender",
    "SafetyAuditLogger",
    "SafetyFilterResult",
    "TruthfulnessResult",
    "TruthfulnessScorer",
]
