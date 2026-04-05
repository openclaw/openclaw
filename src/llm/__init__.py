"""LLM subsystem — gateway routing, inference, OpenRouter cloud API.

Submodules:
  - gateway          : Unified LLM entry point (route_llm, configure, etc.)
  - openrouter       : Cloud LLM API client (circuit breaker + retry)
  - hitl             : Human-in-the-Loop approval gate
"""

from src.llm.gateway import route_llm, configure
from src.llm.hitl import ApprovalRequest

__all__ = ["route_llm", "configure", "ApprovalRequest"]
