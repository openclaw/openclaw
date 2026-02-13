"""Tests for CLI tagline module."""

import random
from datetime import date

from openclaw_py.cli.tagline import DEFAULT_TAGLINE, TAGLINES, active_taglines, pick_tagline


def test_default_tagline():
    """Test default tagline exists."""
    assert DEFAULT_TAGLINE
    assert isinstance(DEFAULT_TAGLINE, str)


def test_taglines_list():
    """Test taglines list is populated."""
    assert TAGLINES
    assert len(TAGLINES) > 0


def test_pick_tagline():
    """Test tagline selection."""
    rng = random.Random(42)
    tagline = pick_tagline(rng=rng)
    assert isinstance(tagline, str)
    assert len(tagline) > 0
