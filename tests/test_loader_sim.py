import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path


class TestLoaderSimulation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(__file__).resolve().parents[1]
        cls.python = sys.executable
        cls.loader_module = "integrations.openclaw_loader_sim"
        cls.verify = cls.root / "sie_verify.py"
        cls.keyring = cls.root / "trusted_issuers.json"
        cls.skill_src = cls.root / "SKILL.md"
        cls.env_src = cls.root / "SKILL.md.sie.json"

    def run_loader(self, skill_path: Path, mode: str, *, json_out: bool = False, config_path: Path | None = None):
        cmd = [
            self.python,
            "-m",
            self.loader_module,
            "--skill",
            str(skill_path),
            "--mode",
            mode,
            "--verify-script",
            str(self.verify),
            "--trusted-issuers",
            str(self.keyring),
        ]
        if config_path:
            cmd.extend(["--config", str(config_path)])
        if json_out:
            cmd.append("--json")

        return subprocess.run(
            cmd,
            cwd=self.root,
            capture_output=True,
            text=True,
        )

    def test_unsigned_warn_allows(self):
        tmp_skill = self.root / "tests" / "tmp_unsigned_warn_skill.md"
        try:
            tmp_skill.write_text("# unsigned\n", encoding="utf-8")
            r = self.run_loader(tmp_skill, "warn")
            self.assertEqual(r.returncode, 0, msg=r.stdout + r.stderr)
            self.assertIn("ALLOW", r.stdout, msg=r.stdout + r.stderr)
        finally:
            tmp_skill.unlink(missing_ok=True)

    def test_unsigned_strict_rejects(self):
        tmp_skill = self.root / "tests" / "tmp_unsigned_strict_skill.md"
        try:
            tmp_skill.write_text("# unsigned\n", encoding="utf-8")
            r = self.run_loader(tmp_skill, "strict")
            self.assertNotEqual(r.returncode, 0, msg=r.stdout + r.stderr)
            self.assertIn("REJECT", r.stdout, msg=r.stdout + r.stderr)
        finally:
            tmp_skill.unlink(missing_ok=True)

    def test_signed_valid_allows(self):
        tmp_skill = self.root / "tests" / "tmp_signed_skill.md"
        tmp_env = Path(f"{tmp_skill}.sie.json")
        try:
            shutil.copyfile(self.skill_src, tmp_skill)
            shutil.copyfile(self.env_src, tmp_env)
            r = self.run_loader(tmp_skill, "strict")
            self.assertEqual(r.returncode, 0, msg=r.stdout + r.stderr)
            self.assertIn("ALLOW: signed skill verified", r.stdout, msg=r.stdout + r.stderr)
        finally:
            tmp_skill.unlink(missing_ok=True)
            tmp_env.unlink(missing_ok=True)

    def test_signed_invalid_rejects(self):
        tmp_skill = self.root / "tests" / "tmp_tampered_skill.md"
        tmp_env = Path(f"{tmp_skill}.sie.json")
        try:
            shutil.copyfile(self.skill_src, tmp_skill)
            env = json.loads(self.env_src.read_text(encoding="utf-8"))
            env["payload"]["content"] += "\n# tamper\n"
            tmp_env.write_text(json.dumps(env), encoding="utf-8")

            r = self.run_loader(tmp_skill, "strict")
            self.assertNotEqual(r.returncode, 0, msg=r.stdout + r.stderr)
            self.assertIn("REJECT", r.stdout, msg=r.stdout + r.stderr)
        finally:
            tmp_skill.unlink(missing_ok=True)
            tmp_env.unlink(missing_ok=True)

    def test_json_output_shape(self):
        tmp_skill = self.root / "tests" / "tmp_unsigned_json_skill.md"
        try:
            tmp_skill.write_text("# unsigned\n", encoding="utf-8")
            r = self.run_loader(tmp_skill, "warn", json_out=True)
            self.assertEqual(r.returncode, 0, msg=r.stdout + r.stderr)
            payload = json.loads(r.stdout)
            self.assertTrue(payload["allowed"])
            self.assertEqual(payload["reason"], "unsigned_warn")
            self.assertIn("warn mode", payload["detail"])
        finally:
            tmp_skill.unlink(missing_ok=True)

    def test_config_overrides_cli_mode(self):
        tmp_skill = self.root / "tests" / "tmp_unsigned_cfg_skill.md"
        tmp_cfg = self.root / "tests" / "tmp_openclaw_cfg.json"
        cfg = {
            "agents": {
                "security": {
                    "sie": {
                        "enabled": True,
                        "strict": True,
                        "verifyScript": str(self.verify),
                        "trustedIssuers": str(self.keyring),
                    }
                }
            }
        }
        try:
            tmp_skill.write_text("# unsigned\n", encoding="utf-8")
            tmp_cfg.write_text(json.dumps(cfg), encoding="utf-8")
            # CLI says warn, config says strict -> should reject.
            r = self.run_loader(tmp_skill, "warn", config_path=tmp_cfg)
            self.assertNotEqual(r.returncode, 0, msg=r.stdout + r.stderr)
            self.assertIn("REJECT", r.stdout, msg=r.stdout + r.stderr)
        finally:
            tmp_skill.unlink(missing_ok=True)
            tmp_cfg.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
