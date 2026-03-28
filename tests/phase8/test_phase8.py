"""Phase 8 Tests — HITL Approval Gate, Mission Control Dashboard, Vision, ClawHub Marketplace."""

import asyncio
import sys
import os
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))


# ═══════════════════════════════════════════════════════════════════════════
# L1 — HITL Approval Gate
# ═══════════════════════════════════════════════════════════════════════════

class TestHITLApproval(unittest.TestCase):
    """Test the Human-in-the-Loop approval gate in llm_gateway."""

    def setUp(self):
        from src import llm_gateway
        self.gw = llm_gateway
        # Enable HITL for testing
        self.gw._approval_config = {"enabled": True, "budget_threshold": 0.05, "timeout_sec": 5}
        self.gw._pending_approvals.clear()

    def tearDown(self):
        self.gw._approval_config = {}
        self.gw._pending_approvals.clear()
        self.gw._approval_callback = None

    def test_assess_risk_detects_rm_rf(self):
        req = self.gw.assess_risk("run rm -rf /tmp/test")
        self.assertIsNotNone(req)
        self.assertIn("PENDING_APPROVAL", req.status)
        self.assertTrue(any("rm" in r for r in req.risk_reasons))

    def test_assess_risk_detects_sudo(self):
        req = self.gw.assess_risk("sudo apt-get install foo")
        self.assertIsNotNone(req)
        self.assertTrue(any("sudo" in r for r in req.risk_reasons))

    def test_assess_risk_detects_drop_table(self):
        req = self.gw.assess_risk("DROP TABLE users")
        self.assertIsNotNone(req)
        self.assertTrue(any("drop" in r.lower() for r in req.risk_reasons))

    def test_assess_risk_detects_budget_overrun(self):
        req = self.gw.assess_risk("normal safe prompt", estimated_cost=0.10)
        self.assertIsNotNone(req)
        self.assertTrue(any("cost" in r for r in req.risk_reasons))

    def test_assess_risk_allows_safe_prompt(self):
        req = self.gw.assess_risk("Tell me a fun fact about cats")
        self.assertIsNone(req)

    def test_assess_risk_disabled_returns_none(self):
        self.gw._approval_config = {"enabled": False}
        req = self.gw.assess_risk("sudo rm -rf /")
        self.assertIsNone(req)

    def test_resolve_approval_approve(self):
        req = self.gw.assess_risk("sudo reboot")
        self.assertIsNotNone(req)
        ok = self.gw.resolve_approval(req.request_id, "approve")
        self.assertTrue(ok)
        self.assertEqual(req.status, "APPROVED")

    def test_resolve_approval_reject(self):
        req = self.gw.assess_risk("kill -9 1234")
        ok = self.gw.resolve_approval(req.request_id, "reject")
        self.assertTrue(ok)
        self.assertEqual(req.status, "REJECTED")

    def test_resolve_approval_edit(self):
        req = self.gw.assess_risk("rm -rf /important")
        ok = self.gw.resolve_approval(req.request_id, "edit", edited_prompt="ls /important")
        self.assertTrue(ok)
        self.assertEqual(req.status, "EDITED")
        self.assertEqual(req.edited_prompt, "ls /important")

    def test_resolve_approval_invalid_id(self):
        ok = self.gw.resolve_approval("nonexistent", "approve")
        self.assertFalse(ok)

    def test_resolve_approval_already_resolved(self):
        req = self.gw.assess_risk("sudo halt")
        self.gw.resolve_approval(req.request_id, "approve")
        ok = self.gw.resolve_approval(req.request_id, "approve")
        self.assertFalse(ok)

    def test_set_approval_callback(self):
        async def dummy(approval):
            pass
        self.gw.set_approval_callback(dummy)
        self.assertIs(self.gw._approval_callback, dummy)

    def test_get_pending_approval(self):
        req = self.gw.assess_risk("sudo poweroff")
        found = self.gw.get_pending_approval(req.request_id)
        self.assertIs(found, req)

    def test_approval_request_dataclass(self):
        req = self.gw.ApprovalRequest(
            prompt_preview="test prompt",
            risk_reasons=["reason1"],
            estimated_cost=0.01,
        )
        self.assertEqual(req.status, "PENDING_APPROVAL")
        self.assertIsNotNone(req.request_id)
        req.approve()
        self.assertEqual(req.status, "APPROVED")

    def test_assess_risk_multiple_reasons(self):
        req = self.gw.assess_risk("sudo rm -rf /tmp", estimated_cost=0.10)
        self.assertIsNotNone(req)
        # Should have at least 3 reasons: sudo, rm -rf, budget
        self.assertGreaterEqual(len(req.risk_reasons), 3)


# ═══════════════════════════════════════════════════════════════════════════
# L2 — Mission Control Dashboard (pure API tests, no server)
# ═══════════════════════════════════════════════════════════════════════════

class TestDashboardAPI(unittest.TestCase):
    """Test the Mission Control Dashboard helpers."""

    def test_record_log(self):
        from src.web.api import record_log, _log_buffer
        _log_buffer.clear()
        record_log({"event": "test_log", "level": "info"})
        self.assertEqual(len(_log_buffer), 1)
        self.assertEqual(_log_buffer[0]["event"], "test_log")

    def test_record_log_ring_buffer(self):
        from src.web.api import record_log, _log_buffer
        _log_buffer.clear()
        for i in range(600):
            record_log({"event": f"log_{i}"})
        # maxlen=500, so only last 500 survive
        self.assertEqual(len(_log_buffer), 500)
        self.assertEqual(_log_buffer[0]["event"], "log_100")

    def test_record_pipeline_tree(self):
        from src.web.api import record_pipeline_tree, _pipeline_trees
        _pipeline_trees.clear()
        tree = {"nodes": ["Planner", "Auditor"], "status": "ok"}
        record_pipeline_tree(tree)
        self.assertEqual(len(_pipeline_trees), 1)
        self.assertEqual(_pipeline_trees[0]["tree"]["nodes"][0], "Planner")

    def test_dashboard_log_processor(self):
        from src.web.api import dashboard_log_processor, _log_buffer
        _log_buffer.clear()
        event_dict = {"event": "processor_test", "level": "warning"}
        result = dashboard_log_processor(None, None, event_dict)
        # Processor should return the event_dict unmodified (passthrough)
        self.assertEqual(result["event"], "processor_test")
        # And also record a copy in the buffer
        self.assertEqual(len(_log_buffer), 1)

    def test_init_dashboard(self):
        from src.web.api import init_dashboard
        from src.web import api
        mock_gw = type("GW", (), {"_start_time": 0})()
        mock_pl = type("PL", (), {})()
        mock_cfg = {"dashboard": {"enabled": True}}
        init_dashboard(mock_gw, mock_pl, mock_cfg)
        self.assertIs(api._gateway_ref, mock_gw)
        self.assertIs(api._pipeline_ref, mock_pl)


# ═══════════════════════════════════════════════════════════════════════════
# L3 — Vision Model Selection
# ═══════════════════════════════════════════════════════════════════════════

class TestVisionModelRouting(unittest.TestCase):
    """Test the vision model selection logic in llm_gateway."""

    def test_vision_models_list(self):
        from src.llm_gateway import _VISION_MODELS
        self.assertIsInstance(_VISION_MODELS, list)
        self.assertTrue(len(_VISION_MODELS) >= 1)
        self.assertTrue(all(isinstance(m, str) for m in _VISION_MODELS))

    def test_route_llm_signature_accepts_image(self):
        """Verify route_llm accepts image_url and image_base64 kwargs."""
        import inspect
        from src.llm_gateway import route_llm
        sig = inspect.signature(route_llm)
        self.assertIn("image_url", sig.parameters)
        self.assertIn("image_base64", sig.parameters)
        self.assertIn("skip_approval", sig.parameters)


# ═══════════════════════════════════════════════════════════════════════════
# L4 — ClawHub Marketplace Client
# ═══════════════════════════════════════════════════════════════════════════

class TestClawHubMarketplace(unittest.TestCase):
    """Test ClawHub marketplace methods exist and have correct signatures."""

    def test_publish_skill_exists(self):
        from src.clawhub.client import ClawHubClient
        self.assertTrue(hasattr(ClawHubClient, "publish_skill"))

    def test_fetch_marketplace_skills_exists(self):
        from src.clawhub.client import ClawHubClient
        self.assertTrue(hasattr(ClawHubClient, "fetch_marketplace_skills"))

    def test_sync_skills_with_library_exists(self):
        from src.clawhub.client import ClawHubClient
        self.assertTrue(hasattr(ClawHubClient, "sync_skills_with_library"))

    def test_publish_skill_signature(self):
        import inspect
        from src.clawhub.client import ClawHubClient
        sig = inspect.signature(ClawHubClient.publish_skill)
        params = list(sig.parameters.keys())
        self.assertIn("name", params)
        self.assertIn("description", params)
        self.assertIn("code", params)

    def test_fetch_marketplace_skills_signature(self):
        import inspect
        from src.clawhub.client import ClawHubClient
        sig = inspect.signature(ClawHubClient.fetch_marketplace_skills)
        params = list(sig.parameters.keys())
        self.assertIn("query", params)


# ═══════════════════════════════════════════════════════════════════════════
# L5 — HITL Telegram Handler (unit / structural)
# ═══════════════════════════════════════════════════════════════════════════

class TestTGApprovalHandler(unittest.TestCase):
    """Test structural properties of the Telegram approval handler."""

    def test_build_approval_keyboard(self):
        from src.handlers.tg_approval import build_approval_keyboard
        kb = build_approval_keyboard("abc123")
        # Should have 3 buttons in one row
        self.assertEqual(len(kb.inline_keyboard), 1)
        self.assertEqual(len(kb.inline_keyboard[0]), 3)
        texts = [btn.text for btn in kb.inline_keyboard[0]]
        self.assertIn("✅ Approve", texts)
        self.assertIn("❌ Reject", texts)
        self.assertIn("📝 Edit Plan", texts)

    def test_keyboard_callback_data(self):
        from src.handlers.tg_approval import build_approval_keyboard
        kb = build_approval_keyboard("req42")
        data = [btn.callback_data for btn in kb.inline_keyboard[0]]
        self.assertIn("hitl:approve:req42", data)
        self.assertIn("hitl:reject:req42", data)
        self.assertIn("hitl:edit:req42", data)

    def test_create_approval_notifier_returns_callable(self):
        from src.handlers.tg_approval import create_approval_notifier
        mock_bot = type("Bot", (), {})()
        notifier = create_approval_notifier(mock_bot, 12345)
        self.assertTrue(callable(notifier))


# ═══════════════════════════════════════════════════════════════════════════
# L6 — Integration smoke (imports, wiring)
# ═══════════════════════════════════════════════════════════════════════════

class TestPhase8Integration(unittest.TestCase):
    """Smoke tests for Phase 8 module imports and config."""

    def test_import_hitl_gateway(self):
        from src.llm_gateway import (
            assess_risk,
            set_approval_callback,
            resolve_approval,
            get_pending_approval,
            ApprovalRequest,
        )
        self.assertTrue(callable(assess_risk))

    def test_import_tg_approval(self):
        from src.handlers.tg_approval import (
            build_approval_keyboard,
            send_approval_request,
            handle_hitl_callback,
            create_approval_notifier,
        )
        self.assertTrue(callable(build_approval_keyboard))

    def test_import_dashboard(self):
        from src.web.api import (
            init_dashboard,
            start_dashboard,
            stop_dashboard,
            record_log,
            record_pipeline_tree,
            dashboard_log_processor,
        )
        self.assertTrue(callable(init_dashboard))

    def test_import_clawhub_marketplace(self):
        from src.clawhub.client import ClawHubClient
        self.assertTrue(hasattr(ClawHubClient, "publish_skill"))
        self.assertTrue(hasattr(ClawHubClient, "fetch_marketplace_skills"))
        self.assertTrue(hasattr(ClawHubClient, "sync_skills_with_library"))

    def test_config_has_hitl_block(self):
        import json
        with open("config/openclaw_config.json", encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertIn("hitl", cfg)
        self.assertTrue(cfg["hitl"]["enabled"])
        self.assertIn("budget_threshold", cfg["hitl"])

    def test_config_has_dashboard_block(self):
        import json
        with open("config/openclaw_config.json", encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertIn("dashboard", cfg)
        self.assertTrue(cfg["dashboard"]["enabled"])
        self.assertEqual(cfg["dashboard"]["port"], 8800)

    def test_config_has_vision_model(self):
        import json
        with open("config/openclaw_config.json", encoding="utf-8") as f:
            cfg = json.load(f)
        router = cfg.get("system", {}).get("model_router", {})
        self.assertIn("vision", router)
        self.assertIn("vision", router)
        self.assertTrue(len(router["vision"]) > 0, "vision model must be configured")


if __name__ == "__main__":
    unittest.main()
