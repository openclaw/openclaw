"""Tests for auth profile usage tracking."""

import time

import pytest

from openclaw_py.agents.auth_profiles.types import AuthProfileStore, ProfileUsageStats
from openclaw_py.agents.auth_profiles.usage import (
    calculate_auth_profile_cooldown_ms,
    is_profile_in_cooldown,
    mark_auth_profile_used,
)


class TestCalculateAuthProfileCooldownMs:
    """Tests for calculate_auth_profile_cooldown_ms."""

    def test_first_error_1_minute(self):
        """Test first error gives 1 minute cooldown."""
        result = calculate_auth_profile_cooldown_ms(1)
        assert result == 60 * 1000  # 1 minute

    def test_second_error_5_minutes(self):
        """Test second error gives 5 minutes cooldown."""
        result = calculate_auth_profile_cooldown_ms(2)
        assert result == 5 * 60 * 1000  # 5 minutes

    def test_third_error_25_minutes(self):
        """Test third error gives 25 minutes cooldown."""
        result = calculate_auth_profile_cooldown_ms(3)
        assert result == 25 * 60 * 1000  # 25 minutes

    def test_max_cooldown_1_hour(self):
        """Test cooldown caps at 1 hour."""
        result = calculate_auth_profile_cooldown_ms(10)
        assert result == 60 * 60 * 1000  # 1 hour (max)

    def test_zero_error_count(self):
        """Test zero error count uses normalized value."""
        result = calculate_auth_profile_cooldown_ms(0)
        assert result == 60 * 1000  # 1 minute (normalized to 1)


class TestIsProfileInCooldown:
    """Tests for is_profile_in_cooldown."""

    def test_no_stats(self):
        """Test profile with no usage stats is not in cooldown."""
        store = AuthProfileStore()
        assert not is_profile_in_cooldown(store, "test:profile")

    def test_not_in_cooldown(self):
        """Test profile not in cooldown."""
        now = int(time.time() * 1000)
        store = AuthProfileStore(
            usage_stats={
                "test:profile": ProfileUsageStats(
                    cooldownUntil=now - 1000  # Expired 1 second ago
                )
            }
        )
        assert not is_profile_in_cooldown(store, "test:profile")

    def test_in_cooldown(self):
        """Test profile in cooldown."""
        now = int(time.time() * 1000)
        store = AuthProfileStore(
            usage_stats={
                "test:profile": ProfileUsageStats(
                    cooldownUntil=now + 60000  # 1 minute in future
                )
            }
        )
        assert is_profile_in_cooldown(store, "test:profile")

    def test_disabled_until(self):
        """Test profile disabled (billing error)."""
        now = int(time.time() * 1000)
        store = AuthProfileStore(
            usage_stats={
                "test:profile": ProfileUsageStats(
                    disabledUntil=now + 3600000  # 1 hour in future
                )
            }
        )
        assert is_profile_in_cooldown(store, "test:profile")

    def test_both_cooldown_and_disabled(self):
        """Test profile with both cooldown and disabled."""
        now = int(time.time() * 1000)
        store = AuthProfileStore(
            usage_stats={
                "test:profile": ProfileUsageStats(
                    cooldownUntil=now + 60000,  # 1 minute
                    disabledUntil=now + 3600000,  # 1 hour (later)
                )
            }
        )
        # Should use the later timestamp (disabled_until)
        assert is_profile_in_cooldown(store, "test:profile")


class TestMarkAuthProfileUsed:
    """Tests for mark_auth_profile_used."""

    @pytest.mark.asyncio
    async def test_mark_profile_used_updates_timestamp(self, tmp_path, monkeypatch):
        """Test marking profile as used updates timestamp."""
        from openclaw_py.agents.auth_profiles.types import ApiKeyCredential
        from openclaw_py.agents.auth_profiles.store import save_auth_profile_store

        # Set up temp directory
        monkeypatch.setenv("OPENCLAW_STATE_DIR", str(tmp_path))

        store = AuthProfileStore(
            profiles={
                "test:profile": ApiKeyCredential(
                    type="api_key", provider="test", key="key123"
                )
            }
        )

        # Save store to disk first
        save_auth_profile_store(store, agent_dir=None)

        before = int(time.time() * 1000)
        await mark_auth_profile_used(store, "test:profile")
        after = int(time.time() * 1000)

        assert store.usage_stats is not None
        assert "test:profile" in store.usage_stats
        stats = store.usage_stats["test:profile"]
        assert stats.last_used is not None
        assert before <= stats.last_used <= after

    @pytest.mark.asyncio
    async def test_mark_profile_used_resets_errors(self, tmp_path, monkeypatch):
        """Test marking profile as used resets error count."""
        from openclaw_py.agents.auth_profiles.types import ApiKeyCredential
        from openclaw_py.agents.auth_profiles.store import save_auth_profile_store

        # Set up temp directory
        monkeypatch.setenv("OPENCLAW_STATE_DIR", str(tmp_path))

        store = AuthProfileStore(
            profiles={
                "test:profile": ApiKeyCredential(
                    type="api_key", provider="test", key="key123"
                )
            },
            usageStats={
                "test:profile": ProfileUsageStats(
                    errorCount=5,
                    cooldownUntil=int(time.time() * 1000) + 60000,
                )
            },
        )

        # Save store to disk first
        save_auth_profile_store(store, agent_dir=None)

        await mark_auth_profile_used(store, "test:profile")

        stats = store.usage_stats["test:profile"]
        assert stats.error_count == 0
        assert stats.cooldown_until is None

    @pytest.mark.asyncio
    async def test_mark_nonexistent_profile(self):
        """Test marking nonexistent profile does nothing."""
        store = AuthProfileStore()
        await mark_auth_profile_used(store, "nonexistent")
        # Should not crash, just do nothing
        assert store.usage_stats is None or "nonexistent" not in (store.usage_stats or {})
