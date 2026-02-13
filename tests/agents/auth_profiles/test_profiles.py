"""Tests for auth profile operations."""

import pytest

from openclaw_py.agents.auth_profiles.profiles import (
    list_profiles_for_provider,
    normalize_secret_input,
    upsert_auth_profile,
)
from openclaw_py.agents.auth_profiles.types import ApiKeyCredential, AuthProfileStore


class TestNormalizeSecretInput:
    """Tests for normalize_secret_input."""

    def test_trim_whitespace(self):
        """Test trimming whitespace."""
        assert normalize_secret_input("  secret123  ") == "secret123"

    def test_no_whitespace(self):
        """Test secret without whitespace."""
        assert normalize_secret_input("secret123") == "secret123"

    def test_empty_string(self):
        """Test empty string."""
        assert normalize_secret_input("") == ""


class TestListProfilesForProvider:
    """Tests for list_profiles_for_provider."""

    def test_list_empty_store(self):
        """Test listing profiles from empty store."""
        store = AuthProfileStore()
        profiles = list_profiles_for_provider(store, "anthropic")
        assert profiles == []

    def test_list_single_provider(self):
        """Test listing profiles for single provider."""
        store = AuthProfileStore(
            profiles={
                "anthropic:default": ApiKeyCredential(
                    type="api_key", provider="anthropic", key="test"
                ),
                "anthropic:profile2": ApiKeyCredential(
                    type="api_key", provider="anthropic", key="test2"
                ),
            }
        )
        profiles = list_profiles_for_provider(store, "anthropic")
        assert len(profiles) == 2
        assert "anthropic:default" in profiles
        assert "anthropic:profile2" in profiles

    def test_list_filter_by_provider(self):
        """Test filtering profiles by provider."""
        store = AuthProfileStore(
            profiles={
                "anthropic:default": ApiKeyCredential(
                    type="api_key", provider="anthropic", key="test"
                ),
                "openai:default": ApiKeyCredential(
                    type="api_key", provider="openai", key="test"
                ),
            }
        )
        anthropic_profiles = list_profiles_for_provider(store, "anthropic")
        openai_profiles = list_profiles_for_provider(store, "openai")

        assert len(anthropic_profiles) == 1
        assert "anthropic:default" in anthropic_profiles

        assert len(openai_profiles) == 1
        assert "openai:default" in openai_profiles

    def test_list_case_insensitive_provider(self):
        """Test provider matching is case-insensitive."""
        store = AuthProfileStore(
            profiles={
                "Anthropic:default": ApiKeyCredential(
                    type="api_key", provider="Anthropic", key="test"
                )
            }
        )
        profiles = list_profiles_for_provider(store, "anthropic")
        assert len(profiles) == 1
