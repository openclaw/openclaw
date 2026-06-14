import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
WATCHDOG_PATH = REPO_ROOT / "scripts/gateway_health_watchdog.py"
SPEC = importlib.util.spec_from_file_location("gateway_health_watchdog", WATCHDOG_PATH)
watchdog = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(watchdog)


class GatewayHealthWatchdogTest(unittest.TestCase):
    def test_protocol_version_reads_current_typescript_constant(self) -> None:
        self.assertEqual(watchdog._read_protocol_version_from_repo(), 4)

    def test_gateway_port_parser_matches_supported_env_values(self) -> None:
        cases = {
            "18789": 18789,
            " 18789 ": 18789,
            "127.0.0.1:18789": 18789,
            "[::1]:28789": 28789,
            "host:not-a-port": None,
            "::1:28789": None,
            "0": None,
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(watchdog._parse_gateway_port_value(value), expected)

    def test_resolve_gateway_port_uses_host_bound_env_port(self) -> None:
        previous = os.environ.get("OPENCLAW_GATEWAY_PORT")
        os.environ["OPENCLAW_GATEWAY_PORT"] = "127.0.0.1:28789"
        try:
            self.assertEqual(watchdog._resolve_gateway_port({}), 28789)
        finally:
            if previous is None:
                os.environ.pop("OPENCLAW_GATEWAY_PORT", None)
            else:
                os.environ["OPENCLAW_GATEWAY_PORT"] = previous

    def test_kickstart_requires_explicit_env_opt_in(self) -> None:
        self.assertFalse(watchdog.is_kickstart_allowed({}))
        self.assertFalse(watchdog.is_kickstart_allowed({"GATEWAY_WATCHDOG_ALLOW_KICKSTART": "0"}))
        self.assertTrue(watchdog.is_kickstart_allowed({"GATEWAY_WATCHDOG_ALLOW_KICKSTART": "1"}))
        self.assertTrue(watchdog.is_kickstart_allowed({"GATEWAY_WATCHDOG_ALLOW_KICKSTART": "true"}))
        self.assertTrue(watchdog.is_kickstart_allowed({"GATEWAY_WATCHDOG_ALLOW_KICKSTART": "yes"}))

    def test_secret_input_resolves_full_env_ref_with_allowlist(self) -> None:
        config = {
            "secrets": {
                "providers": {
                    "gateway-env": {"source": "env", "allowlist": ["GATEWAY_TOKEN_REF"]},
                },
            },
        }
        value = {"source": "env", "provider": "gateway-env", "id": "GATEWAY_TOKEN_REF"}
        self.assertEqual(
            watchdog._resolve_secret_input_string(
                value,
                {"GATEWAY_TOKEN_REF": "env-token"},
                config,
            ),
            "env-token",
        )

    def test_secret_input_resolves_file_ref_json_pointer(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            secret_file = Path(tmp) / "secrets.json"
            secret_file.write_text(
                json.dumps({"gateway": {"token": "file-token"}}),
                encoding="utf-8",
            )
            config = {
                "secrets": {
                    "providers": {
                        "gateway-file": {"source": "file", "path": str(secret_file)},
                    },
                },
            }
            value = {"source": "file", "provider": "gateway-file", "id": "/gateway/token"}
            self.assertEqual(
                watchdog._resolve_secret_input_string(value, {}, config),
                "file-token",
            )

    def test_secret_input_resolves_exec_ref(self) -> None:
        code = (
            "import json,sys;"
            "request=json.loads(sys.stdin.read());"
            "print(json.dumps({'protocolVersion':1,'values':{request['ids'][0]:'exec-token'}}))"
        )
        config = {
            "secrets": {
                "providers": {
                    "gateway-exec": {
                        "source": "exec",
                        "command": sys.executable,
                        "args": ["-c", code],
                    },
                },
            },
        }
        value = {"source": "exec", "provider": "gateway-exec", "id": "gateway/token"}
        self.assertEqual(watchdog._resolve_secret_input_string(value, {}, config), "exec-token")


if __name__ == "__main__":
    unittest.main()
