"""Backward-compatible façade — real code lives in ``src/research/``."""

from src.research._core import (
    DeepResearchPipeline,
    EvidencePiece,
    ResearchState,
    _CONFIDENCE_THRESHOLD,
    _DEPTH_PROFILES,
)

__all__ = [
    "DeepResearchPipeline",
    "EvidencePiece",
    "ResearchState",
    "_CONFIDENCE_THRESHOLD",
    "_DEPTH_PROFILES",
]
