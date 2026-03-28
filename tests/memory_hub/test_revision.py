import tempfile
import unittest
from pathlib import Path

from scripts.memory_hub.revision import capture_source_revision, cas_matches


class RevisionTest(unittest.TestCase):
    def test_cas_matches_rejects_changed_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "MEMORY.md"
            path.write_text("first\n", encoding="utf-8")
            old_revision = capture_source_revision(path)
            path.write_text("second\n", encoding="utf-8")
            self.assertFalse(cas_matches(path, old_revision))
