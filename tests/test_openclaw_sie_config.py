import json
import unittest
from pathlib import Path

from integrations.openclaw_sie_config import parse_sie_runtime_config, load_sie_runtime_config


class TestOpenclawSieConfig(unittest.TestCase):
    def test_defaults_when_missing(self):
        cfg = parse_sie_runtime_config({}, base_dir=Path("/repo"))
        self.assertFalse(cfg.enabled)
        self.assertEqual(cfg.mode, "warn")
        self.assertEqual(cfg.verify_script, Path("/repo/sie_verify.py"))
        self.assertEqual(cfg.trusted_issuers, Path("/repo/trusted_issuers.json"))
        self.assertEqual(cfg.envelope_suffix, ".sie.json")

    def test_explicit_strict_config(self):
        data = {
            "agents": {
                "security": {
                    "sie": {
                        "enabled": True,
                        "strict": True,
                        "verifyScript": "tools/sie_verify.py",
                        "trustedIssuers": "keys/trusted.json",
                        "envelopeSuffix": ".signed.json",
                    }
                }
            }
        }
        cfg = parse_sie_runtime_config(data, base_dir=Path("/repo"))
        self.assertTrue(cfg.enabled)
        self.assertEqual(cfg.mode, "strict")
        self.assertEqual(cfg.verify_script, Path("/repo/tools/sie_verify.py"))
        self.assertEqual(cfg.trusted_issuers, Path("/repo/keys/trusted.json"))
        self.assertEqual(cfg.envelope_suffix, ".signed.json")

    def test_load_from_file(self):
        tmp = Path("tests/tmp_openclaw_config.json")
        data = {
            "agents": {
                "security": {
                    "sie": {
                        "enabled": True,
                        "strict": False,
                    }
                }
            }
        }
        try:
            tmp.write_text(json.dumps(data), encoding="utf-8")
            cfg = load_sie_runtime_config(tmp)
            self.assertTrue(cfg.enabled)
            self.assertEqual(cfg.mode, "warn")
            self.assertEqual(cfg.verify_script, Path("tests/sie_verify.py"))
            self.assertEqual(cfg.trusted_issuers, Path("tests/trusted_issuers.json"))
        finally:
            tmp.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
