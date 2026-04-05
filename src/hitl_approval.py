"""Backward-compatible shim — real implementation in src/llm/hitl.py."""
from src.llm.hitl import *  # noqa: F401,F403
from src.llm.hitl import _approval_config, _pending_approvals  # noqa: F401
import src.llm.hitl as _hitl_mod


def __getattr__(name: str):
    """Dynamically resolve mutable module-level names from the real module."""
    if name == "_approval_callback":
        return _hitl_mod._approval_callback
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# Proxy setattr so `hitl_approval._approval_callback = X` updates the real module.
import sys as _sys
_this = _sys.modules[__name__]
_original_class = type(_this)


class _ShimModuleType(_original_class):
    def __setattr__(self, name, value):
        if name == "_approval_callback":
            _hitl_mod._approval_callback = value
            return
        super().__setattr__(name, value)


_this.__class__ = _ShimModuleType
