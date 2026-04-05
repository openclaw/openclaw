"""
Human-in-the-Loop (HITL) Approval Gate for LLM pipeline.

Detects risky operations (destructive shell commands, budget overruns)
and pauses pipeline execution until a human approves/rejects/edits.

Extracted from llm_gateway.py for modularity.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine, Dict, List, Optional

import structlog

logger = structlog.get_logger("HITL")

# Risk patterns that trigger approval
_HIGH_RISK_PATTERNS: list[str] = [
    r"\brm\s+-rf\b",
    r"\bsudo\b",
    r"\bshutil\.rmtree\b",
    r"\bos\.remove\b",
    r"\bos\.unlink\b",
    r"\bdrop\s+table\b",
    r"\bdelete\s+from\b",
    r"\bformat\s+[a-z]:",
    r"\bkill\s+-9\b",
    r"\bshutdown\b",
    r"\breboot\b",
]
_COMPILED_RISK_RE = [re.compile(p, re.IGNORECASE) for p in _HIGH_RISK_PATTERNS]

# Budget threshold (USD) above which approval is needed
_BUDGET_APPROVAL_THRESHOLD: float = 0.05

# Approval callback — set by the Telegram/Discord handler at startup
_approval_callback: Optional[Callable[..., Coroutine]] = None
_approval_config: Dict[str, Any] = {}


@dataclass
class ApprovalRequest:
    """Represents a paused pipeline awaiting human approval."""
    request_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    prompt_preview: str = ""
    risk_reasons: List[str] = field(default_factory=list)
    estimated_cost: float = 0.0
    status: str = "PENDING_APPROVAL"  # PENDING_APPROVAL | APPROVED | REJECTED | EDITED
    edited_prompt: Optional[str] = None

    def approve(self) -> None:
        self.status = "APPROVED"

    def reject(self) -> None:
        self.status = "REJECTED"

    def edit(self, new_prompt: str) -> None:
        self.status = "EDITED"
        self.edited_prompt = new_prompt


# Active approval requests keyed by request_id
_pending_approvals: Dict[str, ApprovalRequest] = {}


def set_approval_callback(callback: Callable[..., Coroutine]) -> None:
    """Register the UI callback (Telegram/Discord) for sending approval buttons."""
    global _approval_callback
    _approval_callback = callback


def get_pending_approval(request_id: str) -> Optional[ApprovalRequest]:
    """Retrieve a pending approval request by ID."""
    return _pending_approvals.get(request_id)


def resolve_approval(request_id: str, action: str, edited_prompt: str = "") -> bool:
    """Resolve a pending approval: 'approve', 'reject', or 'edit'."""
    req = _pending_approvals.get(request_id)
    if not req or req.status != "PENDING_APPROVAL":
        return False
    if action == "approve":
        req.approve()
    elif action == "reject":
        req.reject()
    elif action == "edit" and edited_prompt:
        req.edit(edited_prompt)
    else:
        return False
    return True


def assess_risk(prompt: str, estimated_cost: float = 0.0) -> Optional[ApprovalRequest]:
    """Check if a prompt requires human approval. Returns ApprovalRequest or None."""
    if not _approval_config.get("enabled", False):
        return None

    reasons: list[str] = []
    lower = prompt.lower()

    for pat in _COMPILED_RISK_RE:
        if pat.search(lower):
            reasons.append(f"dangerous pattern: {pat.pattern}")

    threshold = _approval_config.get("budget_threshold", _BUDGET_APPROVAL_THRESHOLD)
    if estimated_cost > threshold:
        reasons.append(f"estimated cost ${estimated_cost:.3f} > ${threshold:.3f}")

    if not reasons:
        return None

    req = ApprovalRequest(
        prompt_preview=prompt[:300],
        risk_reasons=reasons,
        estimated_cost=estimated_cost,
    )
    _pending_approvals[req.request_id] = req
    logger.warning("HITL approval gate triggered", request_id=req.request_id, reasons=reasons)
    return req
