"""Tests for CLI application."""

from typer.testing import CliRunner

from openclaw_py.cli.app import create_app

runner = CliRunner()


def test_app_help():
    """Test CLI help command."""
    app = create_app()
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    assert "OpenClaw" in result.stdout


def test_app_version():
    """Test CLI version command."""
    app = create_app()
    result = runner.invoke(app, ["--version"])
    assert result.exit_code == 0
    assert "openclaw" in result.stdout.lower()
