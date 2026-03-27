"""Unit tests for OpenRouter client — per-model circuit breaker, retries, rate limits."""
import asyncio
import sys
import os
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.openrouter_client import (
    _model_circuit_breakers,
    _rate_limit_state,
    _is_circuit_open,
    _record_failure,
    _record_success,
    _update_rate_limits,
    get_rate_limit_info,
    reset_circuit_breakers,
)
import time as _time

_TEST_MODEL = "test/model:free"


# ---------------------------------------------------------------------------
# Circuit Breaker (per-model)
# ---------------------------------------------------------------------------
def test_circuit_initially_closed():
    reset_circuit_breakers()
    assert not _is_circuit_open(_TEST_MODEL)
    print("[PASS] circuit breaker initially closed")


def test_circuit_opens_after_threshold():
    reset_circuit_breakers()

    # Record failures up to threshold (5)
    for _ in range(5):
        _record_failure(_TEST_MODEL)

    cb = _model_circuit_breakers[_TEST_MODEL]
    assert cb["failures"] >= 5
    assert cb["open_until"] > _time.time()
    assert _is_circuit_open(_TEST_MODEL)
    print("[PASS] circuit opens after threshold")


def test_circuit_recovers_after_cooldown():
    reset_circuit_breakers()
    _record_failure(_TEST_MODEL)  # init the entry
    cb = _model_circuit_breakers[_TEST_MODEL]
    cb["failures"] = 5
    cb["open_until"] = _time.time() - 10
    cb["last_failure"] = _time.time() - 200
    # Circuit should auto-close because open_until is in the past
    assert not _is_circuit_open(_TEST_MODEL)
    assert cb["failures"] == 0
    print("[PASS] circuit recovers after cooldown")


def test_record_success_resets():
    reset_circuit_breakers()
    for _ in range(3):
        _record_failure(_TEST_MODEL)
    _record_success(_TEST_MODEL)
    cb = _model_circuit_breakers[_TEST_MODEL]
    assert cb["failures"] == 0
    print("[PASS] record_success resets failures")


def test_per_model_isolation():
    """Failures on model A should not affect model B."""
    reset_circuit_breakers()
    model_a = "vendor/model-a:free"
    model_b = "vendor/model-b:free"
    for _ in range(5):
        _record_failure(model_a)
    assert _is_circuit_open(model_a)
    assert not _is_circuit_open(model_b)
    print("[PASS] per-model isolation")


# ---------------------------------------------------------------------------
# Rate Limit Tracking
# ---------------------------------------------------------------------------
def test_update_rate_limits():
    headers = {
        "x-ratelimit-remaining-requests": "42",
        "x-ratelimit-remaining-tokens": "100000",
    }
    _update_rate_limits(headers)
    assert _rate_limit_state["requests_remaining"] == 42
    assert _rate_limit_state["tokens_remaining"] == 100000
    print("[PASS] rate limit tracking from headers")


def test_rate_limit_info():
    _rate_limit_state["requests_remaining"] = 50
    _rate_limit_state["tokens_remaining"] = 10000
    reset_circuit_breakers()
    info = get_rate_limit_info()
    assert info["requests_remaining"] == 50
    assert info["tokens_remaining"] == 10000
    assert info["circuit_open_models"] == []
    assert info["model_failures"] == {}
    print("[PASS] get_rate_limit_info")


def test_update_rate_limits_missing_headers():
    """Headers without rate limit info should not crash."""
    _rate_limit_state["requests_remaining"] = 999
    _rate_limit_state["tokens_remaining"] = 999999
    _update_rate_limits({"content-type": "application/json"})
    assert _rate_limit_state["requests_remaining"] == 999  # unchanged
    print("[PASS] missing rate limit headers handled")


# ---------------------------------------------------------------------------
# Run all
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    test_circuit_initially_closed()
    test_circuit_opens_after_threshold()
    test_circuit_recovers_after_cooldown()
    test_record_success_resets()
    test_per_model_isolation()
    test_update_rate_limits()
    test_rate_limit_info()
    test_update_rate_limits_missing_headers()
    print("\n✅ All OpenRouter client tests passed!")
