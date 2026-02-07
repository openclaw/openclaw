#!/usr/bin/env python3
"""
Skill Guard mock store server (zero dependencies — stdlib only).

Usage:
  python3 skill-guard-server.py [port]          # default port 0 = random free port
  python3 skill-guard-server.py --port 9876

The server prints a JSON line on startup:
  {"port": 9876, "pid": 12345}

Endpoints:
  GET /api/v1/skill-guard/manifest
  GET /api/v1/skill-guard/skills/<name>
  GET /api/v1/skill-guard/skills/<name>/download

Environment:
  SKILL_GUARD_MANIFEST_JSON — path to a JSON file to use as the manifest.
                               If not set, a built-in test manifest is used.
"""

import json
import os
import re
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

# ── Default test manifest ────────────────────────────────────

DEFAULT_MANIFEST = {
    "store": {"name": "Test Store", "version": "20260207test"},
    "syncIntervalSeconds": 60,
    "blocklist": ["evil-skill"],
    "skills": {
        "good-skill": {
            "version": "1.0.0",
            "publisher": "tester",
            "verified": True,
            "fileCount": 1,
            "files": {
                # Placeholder — the smoke test will inject correct hashes
                "SKILL.md": "0000000000000000000000000000000000000000000000000000000000000000"
            },
        }
    },
}

# ── Load manifest ────────────────────────────────────────────

def load_manifest():
    env_path = os.environ.get("SKILL_GUARD_MANIFEST_JSON")
    if env_path:
        with open(env_path, "r") as f:
            return json.load(f)
    return DEFAULT_MANIFEST

MANIFEST = load_manifest()
MANIFEST_JSON = json.dumps(MANIFEST)
MANIFEST_VERSION = MANIFEST["store"]["version"]

# ── HTTP handler ─────────────────────────────────────────────

MANIFEST_PATH = "/api/v1/skill-guard/manifest"
SKILL_RE = re.compile(r"^/api/v1/skill-guard/skills/([^/]+)$")
DOWNLOAD_RE = re.compile(r"^/api/v1/skill-guard/skills/([^/]+)/download$")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # ── manifest ──
        if self.path == MANIFEST_PATH:
            etag = self.headers.get("If-None-Match", "").strip('"')
            if etag == MANIFEST_VERSION:
                self.send_response(304)
                self.end_headers()
                return
            body = MANIFEST_JSON.encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("ETag", f'"{MANIFEST_VERSION}"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # ── single skill ──
        m = SKILL_RE.match(self.path)
        if m:
            name = m.group(1)
            skill = MANIFEST["skills"].get(name)
            if not skill:
                body = json.dumps({"error": "skill_not_found"}).encode()
                self.send_response(404)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            resp = {"name": name, **skill}
            body = json.dumps(resp).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # ── download (stub) ──
        m = DOWNLOAD_RE.match(self.path)
        if m:
            body = b"STUB-TAR-CONTENT"
            self.send_response(200)
            self.send_header("Content-Type", "application/gzip")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # ── 404 ──
        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        # Suppress request logs in test mode
        if os.environ.get("SKILL_GUARD_QUIET"):
            return
        super().log_message(format, *args)


def main():
    port = 0  # random free port
    for arg in sys.argv[1:]:
        if arg.startswith("--port"):
            # --port 9876  or  --port=9876
            if "=" in arg:
                port = int(arg.split("=", 1)[1])
            elif sys.argv.index(arg) + 1 < len(sys.argv):
                port = int(sys.argv[sys.argv.index(arg) + 1])
        elif arg.isdigit():
            port = int(arg)

    server = HTTPServer(("127.0.0.1", port), Handler)
    actual_port = server.server_address[1]

    # Print startup info as JSON (consumed by the test harness)
    startup_info = json.dumps({"port": actual_port, "pid": os.getpid()})
    print(startup_info, flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()


if __name__ == "__main__":
    main()
