"""
Unit tests for action executor
"""

import pytest
from engine.actions.executor import ActionExecutor
from engine.core.models import ActionType, RiskLevel


@pytest.mark.asyncio
async def test_http_get_request():
    """Test HTTP GET request execution"""
    executor = ActionExecutor()
    await executor.initialize()
    
    try:
        result = await executor.execute_action(
            action_type=ActionType.HTTP,
            action_data={
                "method": "GET",
                "url": "https://api.github.com/zen",
            },
            risk_level=RiskLevel.READ_ONLY,
        )
        
        assert result["success"] is True
        assert result["http_status"] == 200
        assert "data" in result
    finally:
        await executor.cleanup()


@pytest.mark.asyncio
async def test_blocked_unsafe_url():
    """Test that unsafe URLs are blocked"""
    executor = ActionExecutor()
    await executor.initialize()
    
    try:
        with pytest.raises(ValueError, match="URL not allowed"):
            await executor.execute_action(
                action_type=ActionType.HTTP,
                action_data={
                    "method": "GET",
                    "url": "http://localhost:8000/admin",
                },
                risk_level=RiskLevel.READ_ONLY,
            )
    finally:
        await executor.cleanup()


@pytest.mark.asyncio
async def test_url_safety_check():
    """Test URL safety validation"""
    executor = ActionExecutor()
    
    # Safe URLs
    assert executor._is_safe_url("https://api.example.com/data") is True
    assert executor._is_safe_url("https://github.com/api") is True
    
    # Unsafe URLs
    assert executor._is_safe_url("http://localhost/admin") is False
    assert executor._is_safe_url("http://127.0.0.1/api") is False
    assert executor._is_safe_url("file:///etc/passwd") is False


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
