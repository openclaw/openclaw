"""Backward-compatible shim — real implementation in src/llm/openrouter.py."""
from src.llm.openrouter import *  # noqa: F401,F403
from src.llm.openrouter import (  # noqa: F401
    _model_circuit_breakers,
    _rate_limit_state,
    _is_circuit_open,
    _record_failure,
    _record_success,
    _update_rate_limits,
    get_rate_limit_info,
    reset_circuit_breakers,
)
