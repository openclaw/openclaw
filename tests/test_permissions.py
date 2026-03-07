"""
Unit tests for permission system
"""

import pytest
from engine.permissions.manager import PermissionManager, PermissionDecision
from engine.core.models import ActionType, RiskLevel


def test_read_only_get_allowed():
    """Test that READ_ONLY agents can perform GET requests"""
    manager = PermissionManager()
    
    decision = manager.check_permission(
        agent_name="test_agent",
        action_type=ActionType.HTTP,
        risk_level=RiskLevel.READ_ONLY,
        action_data={"method": "GET", "url": "https://api.example.com"},
    )
    
    assert decision == PermissionDecision.ALLOWED


def test_read_only_post_requires_approval():
    """Test that READ_ONLY agents need approval for POST"""
    manager = PermissionManager()
    
    decision = manager.check_permission(
        agent_name="test_agent",
        action_type=ActionType.HTTP,
        risk_level=RiskLevel.READ_ONLY,
        action_data={"method": "POST", "url": "https://api.example.com"},
    )
    
    assert decision == PermissionDecision.REQUIRES_APPROVAL


def test_critical_always_requires_approval():
    """Test that CRITICAL risk level always needs approval"""
    manager = PermissionManager()
    
    decision = manager.check_permission(
        agent_name="test_agent",
        action_type=ActionType.HTTP,
        risk_level=RiskLevel.CRITICAL,
        action_data={"method": "GET", "url": "https://api.example.com"},
    )
    
    assert decision == PermissionDecision.REQUIRES_APPROVAL


def test_approval_workflow():
    """Test approval request and approval flow"""
    manager = PermissionManager()
    
    # Request approval
    action_id = manager.request_approval(
        agent_name="test_agent",
        action_type=ActionType.HTTP,
        risk_level=RiskLevel.CRITICAL,
        action_data={"method": "POST"},
    )
    
    assert action_id is not None
    
    # Check pending
    pending = manager.get_pending_approvals()
    assert len(pending) > 0
    assert pending[0]["id"] == action_id
    
    # Approve
    result = manager.approve_action(action_id)
    assert result is True
    
    # Check permission now allowed
    decision = manager.check_permission(
        agent_name="test_agent",
        action_type=ActionType.HTTP,
        risk_level=RiskLevel.CRITICAL,
        action_data={"method": "POST"},
    )
    assert decision == PermissionDecision.ALLOWED


def test_denial_workflow():
    """Test approval denial flow"""
    manager = PermissionManager()
    
    # Request approval
    action_id = manager.request_approval(
        agent_name="test_agent",
        action_type=ActionType.SCRIPT,
        risk_level=RiskLevel.CRITICAL,
        action_data={"script": "test.sh"},
    )
    
    # Deny
    result = manager.deny_action(action_id)
    assert result is True
    
    # Check permission denied
    decision = manager.check_permission(
        agent_name="test_agent",
        action_type=ActionType.SCRIPT,
        risk_level=RiskLevel.CRITICAL,
        action_data={"script": "test.sh"},
    )
    assert decision == PermissionDecision.DENIED


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
