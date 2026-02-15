import json
import shutil
import unittest
from pathlib import Path

from integrations.openclaw_hook import enforce_skill_from_openclaw_config


class TestOpenclawHook(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(__file__).resolve().parents[1]
        cls.skill_src = cls.root / "SKILL.md"
        cls.env_src = cls.root / "SKILL.md.sie.json"

    def test_sie_disabled_allows(self):
        skill = self.root / "tests" / "tmp_hook_unsigned_disabled.md"
        try:
            skill.write_text("# unsigned\n", encoding="utf-8")
            cfg = {"agents": {"security": {"sie": {"enabled": False}}}}
            d = enforce_skill_from_openclaw_config(skill, cfg, base_dir=self.root)
            self.assertTrue(d.allowed)
            self.assertEqual(d.reason, "sie_disabled")
        finally:
            skill.unlink(missing_ok=True)

    def test_sie_enabled_strict_rejects_unsigned(self):
        skill = self.root / "tests" / "tmp_hook_unsigned_strict.md"
        try:
            skill.write_text("# unsigned\n", encoding="utf-8")
            cfg = {
                "agents": {
                    "security": {
                        "sie": {
                            "enabled": True,
                            "strict": True,
                            "verifyScript": "sie_verify.py",
                            "trustedIssuers": "trusted_issuers.json",
                        }
                    }
                }
            }
            d = enforce_skill_from_openclaw_config(skill, cfg, base_dir=self.root)
            self.assertFalse(d.allowed)
            self.assertEqual(d.reason, "unsigned_strict")
        finally:
            skill.unlink(missing_ok=True)

    def test_sie_enabled_strict_allows_valid_signed(self):
        skill = self.root / "tests" / "tmp_hook_signed.md"
        env = Path(f"{skill}.sie.json")
        try:
            shutil.copyfile(self.skill_src, skill)
            shutil.copyfile(self.env_src, env)
            cfg = {
                "agents": {
                    "security": {
                        "sie": {
                            "enabled": True,
                            "strict": True,
                            "verifyScript": "sie_verify.py",
                            "trustedIssuers": "trusted_issuers.json",
                        }
                    }
                }
            }
            d = enforce_skill_from_openclaw_config(skill, cfg, base_dir=self.root)
            self.assertTrue(d.allowed)
            self.assertEqual(d.reason, "verified")
        finally:
            skill.unlink(missing_ok=True)
            env.unlink(missing_ok=True)

    def test_sie_enabled_strict_rejects_invalid_signed(self):
        skill = self.root / "tests" / "tmp_hook_bad_signed.md"
        env = Path(f"{skill}.sie.json")
        try:
            shutil.copyfile(self.skill_src, skill)
            tampered = json.loads(self.env_src.read_text(encoding="utf-8"))
            tampered["payload"]["content"] += "\n# tamper\n"
            env.write_text(json.dumps(tampered), encoding="utf-8")

            cfg = {
                "agents": {
                    "security": {
                        "sie": {
                            "enabled": True,
                            "strict": True,
                            "verifyScript": "sie_verify.py",
                            "trustedIssuers": "trusted_issuers.json",
                        }
                    }
                }
            }
            d = enforce_skill_from_openclaw_config(skill, cfg, base_dir=self.root)
            self.assertFalse(d.allowed)
            self.assertEqual(d.reason, "verify_failed")
        finally:
            skill.unlink(missing_ok=True)
            env.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
