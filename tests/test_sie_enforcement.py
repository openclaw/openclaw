import json
import shutil
import sys
import unittest
from pathlib import Path

from integrations.sie_enforcement import evaluate_skill


class TestSieEnforcement(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(__file__).resolve().parents[1]
        cls.verify = cls.root / "sie_verify.py"
        cls.keyring = cls.root / "trusted_issuers.json"
        cls.skill_src = cls.root / "SKILL.md"
        cls.env_src = cls.root / "SKILL.md.sie.json"

    def test_warn_allows_unsigned(self):
        skill = self.root / "tests" / "tmp_enforce_warn.md"
        try:
            skill.write_text("# unsigned\n", encoding="utf-8")
            d = evaluate_skill(
                skill,
                mode="warn",
                verify_script=self.verify,
                trusted_issuers=self.keyring,
            )
            self.assertTrue(d.allowed)
            self.assertEqual(d.reason, "unsigned_warn")
        finally:
            skill.unlink(missing_ok=True)

    def test_strict_rejects_unsigned(self):
        skill = self.root / "tests" / "tmp_enforce_strict.md"
        try:
            skill.write_text("# unsigned\n", encoding="utf-8")
            d = evaluate_skill(
                skill,
                mode="strict",
                verify_script=self.verify,
                trusted_issuers=self.keyring,
            )
            self.assertFalse(d.allowed)
            self.assertEqual(d.reason, "unsigned_strict")
        finally:
            skill.unlink(missing_ok=True)

    def test_allows_valid_signed(self):
        skill = self.root / "tests" / "tmp_enforce_valid.md"
        env = Path(f"{skill}.sie.json")
        try:
            shutil.copyfile(self.skill_src, skill)
            shutil.copyfile(self.env_src, env)
            d = evaluate_skill(
                skill,
                mode="strict",
                verify_script=self.verify,
                trusted_issuers=self.keyring,
            )
            self.assertTrue(d.allowed)
            self.assertEqual(d.reason, "verified")
        finally:
            skill.unlink(missing_ok=True)
            env.unlink(missing_ok=True)

    def test_rejects_invalid_signed(self):
        skill = self.root / "tests" / "tmp_enforce_bad.md"
        env = Path(f"{skill}.sie.json")
        try:
            shutil.copyfile(self.skill_src, skill)
            tampered = json.loads(self.env_src.read_text(encoding="utf-8"))
            tampered["payload"]["content"] += "\n# tamper\n"
            env.write_text(json.dumps(tampered), encoding="utf-8")

            d = evaluate_skill(
                skill,
                mode="strict",
                verify_script=self.verify,
                trusted_issuers=self.keyring,
            )
            self.assertFalse(d.allowed)
            self.assertEqual(d.reason, "verify_failed")
        finally:
            skill.unlink(missing_ok=True)
            env.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
