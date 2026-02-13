"""Tests for auth profile types."""

import pytest
from pydantic import ValidationError

from openclaw_py.agents.auth_profiles.types import (
    ApiKeyCredential,
    AuthProfileStore,
    OAuthCredential,
    ProfileUsageStats,
    TokenCredential,
)


class TestApiKeyCredential:
    """Tests for ApiKeyCredential."""

    def test_create_api_key_credential(self):
        """Test creating API key credential."""
        cred = ApiKeyCredential(
            type="api_key",
            provider="anthropic",
            key="sk-ant-test123",
            email="test@example.com",
        )
        assert cred.type == "api_key"
        assert cred.provider == "anthropic"
        assert cred.key == "sk-ant-test123"
        assert cred.email == "test@example.com"

    def test_api_key_credential_optional_fields(self):
        """Test API key credential with optional fields."""
        cred = ApiKeyCredential(type="api_key", provider="anthropic")
        assert cred.key is None
        assert cred.email is None
        assert cred.metadata is None


class TestTokenCredential:
    """Tests for TokenCredential."""

    def test_create_token_credential(self):
        """Test creating token credential."""
        cred = TokenCredential(
            type="token",
            provider="openai",
            token="token123",
            expires=1700000000000,
            email="test@example.com",
        )
        assert cred.type == "token"
        assert cred.provider == "openai"
        assert cred.token == "token123"
        assert cred.expires == 1700000000000
        assert cred.email == "test@example.com"

    def test_token_credential_required_fields(self):
        """Test token credential requires token."""
        with pytest.raises(ValidationError):
            TokenCredential(type="token", provider="openai")


class TestOAuthCredential:
    """Tests for OAuthCredential."""

    def test_create_oauth_credential(self):
        """Test creating OAuth credential."""
        cred = OAuthCredential(
            type="oauth",
            provider="anthropic",
            access="access_token",
            refresh="refresh_token",
            expires=1700000000000,
        )
        assert cred.type == "oauth"
        assert cred.provider == "anthropic"
        assert cred.access == "access_token"
        assert cred.refresh == "refresh_token"
        assert cred.expires == 1700000000000

    def test_oauth_credential_with_aliases(self):
        """Test OAuth credential with field aliases."""
        cred = OAuthCredential(
            type="oauth",
            provider="anthropic",
            access="access_token",
            clientId="client123",
            enterpriseUrl="https://api.example.com",
        )
        assert cred.client_id == "client123"
        assert cred.enterprise_url == "https://api.example.com"


class TestProfileUsageStats:
    """Tests for ProfileUsageStats."""

    def test_create_usage_stats(self):
        """Test creating usage stats."""
        stats = ProfileUsageStats(
            lastUsed=1700000000000,
            errorCount=2,
            cooldownUntil=1700001000000,
        )
        assert stats.last_used == 1700000000000
        assert stats.error_count == 2
        assert stats.cooldown_until == 1700001000000

    def test_usage_stats_all_fields(self):
        """Test usage stats with all fields."""
        stats = ProfileUsageStats(
            lastUsed=1700000000000,
            cooldownUntil=1700001000000,
            disabledUntil=1700002000000,
            disabledReason="billing",
            errorCount=3,
            failureCounts={"billing": 1, "rate_limit": 2},
            lastFailureAt=1700000500000,
        )
        assert stats.disabled_reason == "billing"
        assert stats.failure_counts == {"billing": 1, "rate_limit": 2}
        assert stats.last_failure_at == 1700000500000


class TestAuthProfileStore:
    """Tests for AuthProfileStore."""

    def test_create_empty_store(self):
        """Test creating empty auth profile store."""
        store = AuthProfileStore()
        assert store.version == 1
        assert store.profiles == {}
        assert store.order is None
        assert store.last_good is None
        assert store.usage_stats is None

    def test_create_store_with_profiles(self):
        """Test creating store with profiles."""
        store = AuthProfileStore(
            profiles={
                "anthropic:default": ApiKeyCredential(
                    type="api_key", provider="anthropic", key="test123"
                )
            }
        )
        assert len(store.profiles) == 1
        assert "anthropic:default" in store.profiles

    def test_store_with_order(self):
        """Test store with profile order."""
        store = AuthProfileStore(
            order={"anthropic": ["anthropic:profile1", "anthropic:profile2"]}
        )
        assert store.order is not None
        assert "anthropic" in store.order
        assert len(store.order["anthropic"]) == 2

    def test_store_serialization(self):
        """Test store serialization."""
        store = AuthProfileStore(
            profiles={
                "anthropic:default": ApiKeyCredential(
                    type="api_key", provider="anthropic", key="test123"
                )
            },
            lastGood={"anthropic": "anthropic:default"},
        )
        data = store.model_dump(by_alias=True, exclude_none=True)
        assert "profiles" in data
        assert "lastGood" in data  # Should use camelCase alias
