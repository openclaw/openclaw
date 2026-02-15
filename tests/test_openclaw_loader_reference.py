import json
import shutil
import unittest
from pathlib import Path

from integrations.openclaw_loader_reference import SkillLoadRejected, load_skill_text_with_sie


class TestOpenclawLoaderReference(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(__file__).resolve().parents[1]
        cls.skill_src = cls.root / "SKILL.md"
        cls.env_src = cls.root / "SKILL.md.sie.json"

    def strict_cfg(self):
        return {
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

    def test_load_allows_valid_signed(self):
        skill = self.root / "tests" / "tmp_ref_ok.md"
        env = Path(f"{skill}.sie.json")
        try:
            shutil.copyfile(self.skill_src, skill)
            shutil.copyfile(self.env_src, env)
            out = load_skill_text_with_sie(skill, self.strict_cfg(), base_dir=self.root)
            self.assertIn("SIE", out)
        finally:
            skill.unlink(missing_ok=True)
            env.unlink(missing_ok=True)

    def test_load_rejects_unsigned_strict(self):
        skill = self.root / "tests" / "tmp_ref_unsigned.md"
        try:
            skill.write_text("# unsigned\n", encoding="utf-8")
            with self.assertRaises(SkillLoadRejected):
                load_skill_text_with_sie(skill, self.strict_cfg(), base_dir=self.root)
        finally:
            skill.unlink(missing_ok=True)

    def test_load_rejects_invalid_signed(self):
        skill = self.root / "tests" / "tmp_ref_bad.md"
        env = Path(f"{skill}.sie.json")
        try:
            shutil.copyfile(self.skill_src, skill)
            tampered = json.loads(self.env_src.read_text(encoding="utf-8"))
            tampered["payload"]["content"] += "\n# tamper\n"
            env.write_text(json.dumps(tampered), encoding="utf-8")

            with self.assertRaises(SkillLoadRejected):
                load_skill_text_with_sie(skill, self.strict_cfg(), base_dir=self.root)
        finally:
            skill.unlink(missing_ok=True)
            env.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
