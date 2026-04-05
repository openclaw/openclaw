"""Backward-compatible shim — real implementation in src/llm/gateway.py."""
from src.llm.gateway import *  # noqa: F401,F403
from src.llm.gateway import (  # noqa: F401 — explicit re-export of private names used by tests
    _VISION_MODELS,
    _last_api_error,
    _pending_approvals,
    route_llm,
    configure,
    set_approval_callback,
    get_last_api_error,
    get_metrics_collector,
    is_cloud_only,
    ApprovalRequest,
    resolve_approval,
)
