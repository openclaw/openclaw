import json
import subprocess
import sys
from pathlib import Path
import unittest


class TestVerifyCli(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(__file__).resolve().parents[1]
        cls.python = sys.executable
        cls.verify = cls.root / "sie_verify.py"
        cls.env_file = cls.root / "SKILL.md.sie.json"
        cls.skill_file = cls.root / "SKILL.md"
        cls.keyring = cls.root / "trusted_issuers.json"

    def run_cmd(self, *args):
        return subprocess.run(
            [self.python, str(self.verify), *args],
            cwd=self.root,
            capture_output=True,
            text=True,
        )

    def test_verify_ok_with_trusted_issuers(self):
        r = self.run_cmd(
            "--file", str(self.env_file),
            "--trusted-issuers", str(self.keyring),
        )
        self.assertEqual(r.returncode, 0, msg=r.stdout + r.stderr)
        self.assertIn("[OK]", r.stdout)

    def test_verify_ok_with_check_file(self):
        r = self.run_cmd(
            "--file", str(self.env_file),
            "--trusted-issuers", str(self.keyring),
            "--check-file", str(self.skill_file),
        )
        self.assertEqual(r.returncode, 0, msg=r.stdout + r.stderr)
        self.assertIn("[OK]", r.stdout)

    def test_verify_ok_with_pubkey_override(self):
        env = json.loads(self.env_file.read_text(encoding="utf-8"))
        issuer = env.get("issuer")
        keyring = json.loads(self.keyring.read_text(encoding="utf-8"))
        pub = keyring[issuer]

        r = self.run_cmd(
            "--file", str(self.env_file),
            "--pubkey", pub,
        )
        self.assertEqual(r.returncode, 0, msg=r.stdout + r.stderr)
        self.assertIn("[OK]", r.stdout)

    def test_payload_issuer_without_top_level_fails_signature(self):
        env = json.loads(self.env_file.read_text(encoding="utf-8"))
        issuer = env.get("issuer")
        env.pop("issuer", None)
        env.setdefault("payload", {})["issuer"] = issuer

        tmp_env = self.root / "tests" / "tmp_payload_issuer.sie.json"
        try:
            tmp_env.write_text(json.dumps(env), encoding="utf-8")
            r = self.run_cmd(
                "--file", str(tmp_env),
                "--trusted-issuers", str(self.keyring),
            )
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("bad signature", (r.stdout + r.stderr).lower())
        finally:
            tmp_env.unlink(missing_ok=True)

    def test_untrusted_issuer_fails(self):
        bad_keyring = self.root / "tests" / "tmp_bad_issuers.json"
        bad_keyring.write_text("{}", encoding="utf-8")
        try:
            r = self.run_cmd(
                "--file", str(self.env_file),
                "--trusted-issuers", str(bad_keyring),
            )
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("not trusted", (r.stdout + r.stderr).lower())
        finally:
            bad_keyring.unlink(missing_ok=True)

    def test_hash_mismatch_fails(self):
        tampered = self.root / "tests" / "tmp_tampered_skill.md"
        try:
            tampered.write_text(self.skill_file.read_text(encoding="utf-8") + "\n# tamper\n", encoding="utf-8")
            r = self.run_cmd(
                "--file", str(self.env_file),
                "--trusted-issuers", str(self.keyring),
                "--check-file", str(tampered),
            )
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("hash", (r.stdout + r.stderr).lower())
        finally:
            tampered.unlink(missing_ok=True)

    def test_missing_issuer_fails(self):
        env = json.loads(self.env_file.read_text(encoding="utf-8"))
        env.pop("issuer", None)
        env.get("payload", {}).pop("issuer", None)

        tmp_env = self.root / "tests" / "tmp_missing_issuer.sie.json"
        try:
            tmp_env.write_text(json.dumps(env), encoding="utf-8")
            r = self.run_cmd(
                "--file", str(tmp_env),
                "--trusted-issuers", str(self.keyring),
            )
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("missing issuer", (r.stdout + r.stderr).lower())
        finally:
            tmp_env.unlink(missing_ok=True)

    def test_malformed_envelope_json_fails(self):
        bad_env = self.root / "tests" / "tmp_malformed.sie.json"
        try:
            bad_env.write_text("{not-json", encoding="utf-8")
            r = self.run_cmd(
                "--file", str(bad_env),
                "--trusted-issuers", str(self.keyring),
            )
            self.assertNotEqual(r.returncode, 0)
        finally:
            bad_env.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
