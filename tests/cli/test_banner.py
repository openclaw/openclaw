"""Tests for CLI banner module."""

from openclaw_py.cli.banner import format_cli_banner_line


def test_format_banner_line():
    """Test banner line formatting."""
    line = format_cli_banner_line(
        version="1.0.0",
        commit="abc123",
        tagline="Test tagline",
        rich=False,
    )
    assert "1.0.0" in line
    assert "abc123" in line
    assert "Test tagline" in line
