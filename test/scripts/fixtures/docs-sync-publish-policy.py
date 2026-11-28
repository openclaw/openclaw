"""Real Git/native-owner proof with a local GitHub HTTP boundary; no live writes."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[3]
REPO = "openclaw/docs"
PREFIX = "automation/docs-mirror/"
CONTEXT = "Publication merge admission"


class Publisher(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="docs-publisher-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.remote = self.root / "remote.git"
        self.work = self.root / "publish"
        self.env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
                    "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
                    "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid"}
        self.git("init", "--bare", str(self.remote), cwd=self.root)
        self.git("init", "-b", "main", str(self.work), cwd=self.root)
        self.git("remote", "add", "origin", str(self.remote))
        self.write("docs/page.md", "Original page\n")
        self.write("README.md", "Target-owned readme\n")
        self.write("package.json", '{}\n')
        self.write("package-lock.json", '{}\n')
        self.write(".openclaw-sync/source.json", json.dumps({"repository": "openclaw/openclaw", "sha": "b" * 40}))
        self.git("add", ".")
        self.git("commit", "-qm", "initial")
        self.base = self.git("rev-parse", "HEAD").strip()
        self.git("push", "-q", "origin", "main")
        self.source = "b" * 40
        self.write("docs/page.md", "Validated page\n")
        self.write(".openclaw-sync/source.json", json.dumps({"repository": "openclaw/openclaw", "sha": self.source}))
        self.git("add", ".")
        self.git("commit", "-qm", "generated")
        self.head = self.git("rev-parse", "HEAD").strip()
        self.digest = hashlib.sha1(self.git("ls-tree", "-r", "-z", "HEAD", "--", "docs", ".openclaw-sync", "package.json", "package-lock.json", raw=True)).hexdigest()
        self.branch = PREFIX + self.source + "-" + self.digest + "-" + self.base
        self.pr = None
        self.requests = []
        self.fault = ""
        # Only the polling clock is accelerated. The production native owner
        # still launches and drains every real Git process in these fixtures.
        self.owner = self.root / "owner.py"
        self.owner.write_text((ROOT / ".github/actions/git-owner/owner.py").read_text().replace(
            "retry_at = time.monotonic() + seconds", "retry_at = time.monotonic()"))
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.respond("GET")

            def do_POST(self):
                self.respond("POST")

            def do_PUT(self):
                self.respond("PUT")

            def respond(self, method):
                self.server.timeout = 2
                if self.headers.get("Authorization") != "Bearer fixture-token":
                    self.send_error(401)
                    return
                parsed = urlsplit(self.path)
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or "null")
                fixture.requests.append((method, parsed.path, body))
                code, response, headers = fixture.route(method, parsed.path, parse_qs(parsed.query), body)
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                for key, value in headers.items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(json.dumps(response).encode())

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def write(self, name, value):
        path = self.work / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)

    def git(self, *args, cwd=None, raw=False, input=None):
        result = subprocess.run(["git", *args], cwd=cwd or self.work, env=self.env,
                                input=input, capture_output=True, check=True)
        return result.stdout if raw else result.stdout.decode()

    def main(self):
        return self.git("--git-dir=" + str(self.remote), "rev-parse", "main").strip()

    def move_main(self):
        newer = self.git("commit-tree", self.base + "^{tree}", "-p", self.base,
                         input=b"Concurrent target edit\n").strip()
        self.git("--git-dir=" + str(self.remote), "fetch", "-q", str(self.work), newer)
        self.git("--git-dir=" + str(self.remote), "update-ref", "refs/heads/main", newer)
        return newer

    def refs(self):
        lines = self.git("--git-dir=" + str(self.remote), "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/" + PREFIX).splitlines()
        return [{"ref": line.split()[0], "object": {"sha": line.split()[1]}} for line in lines]

    def make_pr(self, branch=None, head=None):
        return {"number": 1, "html_url": "https://github.com/openclaw/docs/pull/1",
                "head": {"ref": branch or self.branch, "sha": head or self.head, "repo": {"full_name": REPO}},
                "base": {"ref": "main", "repo": {"full_name": REPO}}, "state": "open", "draft": False,
                "mergeable": True, "merged": False, "merged_at": None}

    def route(self, method, path, query, body):
        prefix = "/repos/" + REPO + "/"
        path = path.removeprefix(prefix)
        headers = {}
        if path == "/apps/github-actions":
            result = {"id": 15368}
        elif path == "git/matching-refs/heads/" + PREFIX or path == "git/matching-refs/heads/" + self.branch:
            result = self.refs()
            if self.fault == "branch-race" and not result:
                # The competing ref is a fast-forward ancestor. Only an empty
                # lease, not an ordinary push, protects it after the inventory.
                self.git("--git-dir=" + str(self.remote), "update-ref", "refs/heads/" + self.branch, self.base)
        elif path == "pulls" and method == "GET":
            result = [self.pr] if self.pr and (query.get("state") != ["open"] or self.pr["state"] == "open") else []
            if self.fault == "incomplete":
                headers["Link"] = '<https://example.invalid/next>; rel="next"'
        elif path == "pulls" and method == "POST":
            assert body["head"] == self.branch and body["base"] == "main"
            assert "[skip ci]" not in body["title"]
            self.pr = self.make_pr()
            if self.fault == "create-lost":
                return 502, {}, {}
            result = self.pr
        elif path == "pulls/1":
            result = self.pr
        elif path == "rules/branches/main":
            result = [{"type": "non_fast_forward", "ruleset_id": 42}]
            if self.fault != "missing-rule":
                result.append({"type": "required_status_checks", "ruleset_id": 42,
                               "parameters": {"strict_required_status_checks_policy": True,
                                              "required_status_checks": [{"context": CONTEXT, "integration_id": 15368}]}})
        elif path == "rulesets/42":
            result = {"enforcement": "active", "bypass_actors": [], "current_user_can_bypass": "never"}
            if self.fault == "bypass":
                result["bypass_actors"] = [{"actor_id": 5}]
            elif self.fault == "null-bypass":
                result["bypass_actors"] = None
        elif path == "commits/" + self.head + "/statuses":
            if self.fault == "base-drift":
                self.move_main()
            result = [{"context": CONTEXT, "state": "failure" if self.fault == "failed-status" else "success",
                       "creator": {"login": "github-actions[bot]", "type": "Bot"}}]
        elif path == "pulls/1/merge" and method == "PUT":
            assert body == {"sha": self.head, "merge_method": "squash"}
            if self.fault == "server-race":
                self.move_main()
            if self.main() != self.base:
                return 405, {"merged": False}, {}
            tree = self.base if self.fault == "wrong-receipt" else self.head
            merged = self.git("--git-dir=" + str(self.remote), "commit-tree", tree + "^{tree}", "-p", self.base,
                              input=b"Squash generated docs\n").strip()
            self.git("--git-dir=" + str(self.remote), "update-ref", "refs/heads/main", merged)
            self.pr.update(merged=True, merged_at="2026-01-01T00:00:00Z", merge_commit_sha=merged, state="closed")
            if self.fault == "retargeted-receipt":
                self.pr["base"]["ref"] = "other"
            if self.fault == "merge-lost":
                return 502, {}, {}
            result = {"merged": True, "sha": merged}
        else:
            raise AssertionError((method, path, query, body))
        return 200, result, headers

    def run_policy(self, mode="publish"):
        env = {**self.env, "GITHUB_WORKSPACE": str(self.root), "GITHUB_REPOSITORY": "openclaw/openclaw",
               "GITHUB_SHA": self.source, "OPENCLAW_DOCS_SYNC_TOKEN": "fixture-token",
               "GITHUB_API_URL": "http://127.0.0.1:" + str(self.server.server_port),
               "DOCS_PUBLISH_HEAD": self.head, "DOCS_PUBLISH_BASE": self.base, "DOCS_PUBLISH_TREE": self.digest}
        result = subprocess.run([sys.executable, "-I", "-S", str(self.owner), "--policy",
                                 str(ROOT / "scripts/docs-sync-publish-policy.py"), mode], cwd=self.work,
                                env=env, capture_output=True, text=True, timeout=20)
        self.assertNotIn("fixture-token", result.stdout + result.stderr)
        return result

    def assert_held(self, result, message):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(message, result.stdout + result.stderr)
        self.assertNotIn("Published docs", result.stdout)
        self.assertIsNone(self.pr and self.pr.get("merged_at"))

    def test_normal_squash_and_uncertain_responses_have_real_receipts(self):
        for fault in ("", "create-lost", "merge-lost"):
            with self.subTest(fault=fault):
                self.fault = fault
                result = self.run_policy()
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("Published docs", result.stdout)
                merged = self.main()
                self.assertNotEqual(merged, self.head)
                self.assertEqual(self.git("--git-dir=" + str(self.remote), "show", merged + ":docs/page.md"), "Validated page\n")
                self.assertEqual(self.git("--git-dir=" + str(self.remote), "rev-parse", merged + "^" ).strip(), self.base)
                self.git("--git-dir=" + str(self.remote), "update-ref", "refs/heads/main", self.base)
                self.git("update-ref", "refs/remotes/origin/main", self.base)
                self.pr = None

    def test_inactive_gate_or_bypass_preserves_pr_and_branch(self):
        for fault in ("missing-rule", "bypass", "null-bypass", "failed-status"):
            with self.subTest(fault=fault):
                self.fault = fault
                result = self.run_policy()
                self.assert_held(result, "publication")
                self.assertEqual(self.main(), self.base)
                self.assertEqual(self.refs()[0]["object"]["sha"], self.head)
                self.pr = None

    def test_base_drift_before_and_during_merge_cannot_publish(self):
        for fault in ("base-drift", "server-race"):
            with self.subTest(fault=fault):
                self.fault = fault
                result = self.run_policy()
                self.assert_held(result, "held")
                self.assertNotEqual(self.main(), self.base)
                self.git("--git-dir=" + str(self.remote), "update-ref", "refs/heads/main", self.base)
                self.git("update-ref", "refs/remotes/origin/main", self.base)
                self.pr = None

    def test_wrong_merged_tree_is_never_reported_published(self):
        self.fault = "wrong-receipt"
        result = self.run_policy()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Published docs", result.stdout)
        self.assertIn("owned tree changed", result.stderr)

    def test_guard_holds_open_closed_and_orphan_candidates(self):
        self.git("push", "-q", "origin", self.head + ":refs/heads/" + self.branch)
        for state in ("open", "closed", "orphan"):
            with self.subTest(state=state):
                self.pr = self.make_pr() if state != "orphan" else None
                if self.pr:
                    self.pr["state"] = state
                self.assert_held(self.run_policy("guard"), "Unresolved docs mirror")
        self.assertEqual(self.refs()[0]["object"]["sha"], self.head)

    def test_concurrent_branch_creation_is_not_fast_forwarded(self):
        self.fault = "branch-race"
        self.assert_held(self.run_policy(), "Candidate creation could not be confirmed")
        self.assertEqual(self.refs()[0]["object"]["sha"], self.base)
        self.assertEqual(self.main(), self.base)

    def test_retargeted_merge_receipt_is_not_publication(self):
        self.fault = "retargeted-receipt"
        result = self.run_policy()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Published docs", result.stdout)
        self.assertIn("not merged into the target", result.stderr)

    def test_incomplete_inventory_holds_without_writing(self):
        self.fault = "incomplete"
        self.assert_held(self.run_policy(), "Incomplete GitHub enumeration")
        self.assertEqual(self.refs(), [])

    def test_changed_unowned_path_fails_before_push(self):
        self.write("README.md", "Not owned by the mirror\n")
        self.git("add", "README.md")
        self.git("commit", "--amend", "--no-edit", "-q")
        self.head = self.git("rev-parse", "HEAD").strip()
        self.assert_held(self.run_policy(), "outside the docs mirror owner")
        self.assertEqual(self.refs(), [])


if __name__ == "__main__":
    unittest.main()
