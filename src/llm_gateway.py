"""Backward-compatible shim — real implementation in src/llm/gateway.py.

All imports should migrate to `from src.llm.gateway import ...` directly.
This shim remains for 5 call-sites that still import from src.llm_gateway.
"""
from src.llm.gateway import (  # noqa: F401
    # Public API
    configure,
    route_llm,
    get_last_api_error,
    get_metrics_collector,
    get_token_budget,
    is_cloud_only,
    # HITL (re-exported from src.llm.hitl)
    ApprovalRequest,
    assess_risk,
    get_pending_approval,
    assess_risk,
    get_pending_approval,
    resolve_approval,
    set_approval_callback,
    # Private — used by pipeline/_state.py and tests
    _smart_router,
    _VISION_MODELS,
    _last_api_error,
    _pending_approvals,
)
