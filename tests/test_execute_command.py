"""Tests for execute_command() routing logic in agent_queue_worker.py.

Covers:
- Input validation (missing keys, body too large, system paths)
- Agent routing (ron, codex, cowork, guardian, data-analyst)
- Codex non-coding reroute to cowork
- Keyword-based branch selection within each agent
- Unknown agent fallback
- Triad sync dispatch
"""
import sys
from pathlib import Path

SCRIPTS_DIR = str(Path(__file__).parent.parent / "scripts")
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import pytest
from unittest.mock import patch, MagicMock, call


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _cmd(agent, title="test", body="some body", cmd_id=1):
    """Build a minimal valid cmd_row dict."""
    return agent, {"id": cmd_id, "title": title, "body": body}


# We need to patch several module-level dependencies before importing
# execute_command.  Import the module once and reference from there.
import agent_queue_worker as aqw


# ===========================================================================
# 1. INPUT VALIDATION
# ===========================================================================

class TestInputValidation:
    """Validate that execute_command rejects malformed payloads early."""

    def test_missing_id(self):
        ok, msg = aqw.execute_command("ron", {"title": "t", "body": "b"})
        assert ok is False
        assert "missing id" in msg

    def test_missing_title(self):
        ok, msg = aqw.execute_command("ron", {"id": 1, "body": "b"})
        assert ok is False
        assert "missing title" in msg

    def test_missing_body(self):
        ok, msg = aqw.execute_command("ron", {"id": 1, "title": "t"})
        assert ok is False
        assert "missing body" in msg

    def test_body_too_large(self):
        ok, msg = aqw.execute_command("ron", {"id": 1, "title": "t", "body": "x" * 2001})
        assert ok is False
        assert "too large" in msg

    def test_body_exactly_2000_ok(self):
        """Body of exactly 2000 chars should pass validation."""
        with patch.object(aqw, "llm_execute", return_value=(True, "ok")), \
             patch.object(aqw, "read_relevant_playbook", return_value=""):
            ok, _ = aqw.execute_command("ron", {"id": 1, "title": "t", "body": "x" * 2000})
            assert ok is True

    def test_system_path_refused(self):
        ok, msg = aqw.execute_command("ron", {
            "id": 1, "title": "t",
            "body": "read file /usr/local/secrets.txt"
        })
        assert ok is False
        assert "system path" in msg

    def test_etc_path_refused(self):
        ok, msg = aqw.execute_command("ron", {
            "id": 1, "title": "t",
            "body": "cat /etc/passwd"
        })
        assert ok is False
        assert "system path" in msg

    def test_workspace_path_allowed(self):
        """Paths inside WORKSPACE should not be refused."""
        with patch.object(aqw, "llm_execute", return_value=(True, "ok")), \
             patch.object(aqw, "read_relevant_playbook", return_value=""):
            ok, _ = aqw.execute_command("ron", {
                "id": 1, "title": "t",
                "body": f"edit {aqw.WORKSPACE}/scripts/foo.py"
            })
            assert ok is True


# ===========================================================================
# 2. RON AGENT ROUTING
# ===========================================================================

class TestRonRouting:
    """Verify ron keyword-based branch selection."""

    @patch.object(aqw, "sync_ron_structure_brief", return_value=(True, "brief ok"))
    def test_structure_brief(self, mock_brief):
        aqw.RON_BRIEF_CACHE["phase"] = "phase2"
        ok, msg = aqw.execute_command(*_cmd("ron", title="구조 인지 확인"))
        assert ok is True
        assert "structure brief" in msg
        mock_brief.assert_called_once_with(force=True)

    @patch.object(aqw, "run_cmd", return_value=(0, "cycle output", ""))
    def test_run_cycle(self, mock_run):
        ok, msg = aqw.execute_command(*_cmd("ron", title="run-cycle"))
        assert ok is True
        assert "run-cycle" in msg
        # Should call knowledge_os.py run-cycle
        args = mock_run.call_args[0][0]
        assert "knowledge_os.py" in args[1]
        assert "run-cycle" in args

    @patch.object(aqw, "run_cmd")
    def test_health_check(self, mock_run):
        # First call: health_check.py, second call: knowledge_os.py refresh
        mock_run.side_effect = [
            (0, "7/7 OK", ""),
            (0, "snapshot ok", ""),
        ]
        ok, msg = aqw.execute_command(*_cmd("ron", title="health check"))
        assert ok is True
        assert "health_check.py" in msg
        assert mock_run.call_count == 2

    @patch.object(aqw, "run_cmd", return_value=(1, "", "error"))
    def test_health_check_failure(self, mock_run):
        ok, msg = aqw.execute_command(*_cmd("ron", title="health check"))
        assert ok is False
        assert "health-check failed" in msg

    @patch.object(aqw, "run_cmd", return_value=(0, "exported", ""))
    def test_obsidian_sync(self, mock_run):
        ok, msg = aqw.execute_command(*_cmd("ron", title="vault sync"))
        assert ok is True
        assert "export-obsidian" in msg.lower() or "Obsidian" in msg

    @patch.object(aqw, "run_cmd")
    def test_evolve_metrics(self, mock_run):
        mock_run.side_effect = [
            (0, "metrics data", ""),
            (0, "snapshot ok", ""),
        ]
        ok, msg = aqw.execute_command(*_cmd("ron", title="진화 메트릭"))
        assert ok is True
        assert "metrics" in msg.lower() or "진화" in msg

    @patch.object(aqw, "run_cmd")
    def test_insight_quality(self, mock_run):
        mock_run.side_effect = [
            (0, "snapshot ok", ""),
            (0, "knowledge status output", ""),
        ]
        ok, msg = aqw.execute_command(*_cmd("ron", title="인사이트 품질 점검"))
        assert ok is True
        assert "인사이트" in msg or "insight" in msg.lower()

    @patch.object(aqw, "run_cmd")
    def test_insight_pipeline_all_ok(self, mock_run):
        """인사이트 키워드 → 3 파이프라인 직접 실행."""
        mock_run.side_effect = [
            (0, "filtered 5 ideas", ""),
            (0, "generated 3 hypotheses", ""),
            (0, "sector insights ready", ""),
        ]
        ok, msg = aqw.execute_command(*_cmd("ron", title="오늘의 인사이트 생성"))
        assert ok is True
        assert "discovery_filter" in msg
        assert "hypothesis_engine" in msg
        assert "sector_insights" in msg
        assert "정상 완료" in msg
        assert mock_run.call_count == 3

    @patch.object(aqw, "run_cmd")
    def test_insight_pipeline_partial_failure(self, mock_run):
        """파이프라인 1개 실패해도 partial success."""
        mock_run.side_effect = [
            (0, "filtered", ""),
            (1, "", "hypothesis error"),
            (0, "insights", ""),
        ]
        ok, msg = aqw.execute_command(*_cmd("ron", title="인사이트 도출"))
        assert ok is True  # partial success
        assert "정상 완료" in msg

    @patch.object(aqw, "run_cmd")
    def test_insight_pipeline_all_fail(self, mock_run):
        """파이프라인 전체 실패 → False."""
        mock_run.side_effect = [
            (1, "", "err1"),
            (1, "", "err2"),
            (1, "", "err3"),
        ]
        ok, msg = aqw.execute_command(*_cmd("ron", title="가설 생성"))
        assert ok is False
        assert "실패" in msg

    @patch.object(aqw, "run_cmd")
    def test_insight_keyword_not_quality(self, mock_run):
        """'인사이트'만 있으면 파이프라인, '인사이트 품질'이면 status."""
        mock_run.side_effect = [
            (0, "filtered", ""),
            (0, "hypothesis", ""),
            (0, "sector", ""),
        ]
        ok, msg = aqw.execute_command(*_cmd("ron", title="인사이트 분석"))
        assert ok is True
        assert "파이프라인" in msg
        assert mock_run.call_count == 3

    @patch.object(aqw, "llm_execute", return_value=(True, "research result"))
    @patch.object(aqw, "jpost", return_value={"ok": True})
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    def test_research_task(self, mock_pb, mock_post, mock_llm):
        ok, msg = aqw.execute_command(*_cmd("ron", title="연구: 새로운 주제"))
        assert ok is True
        assert msg == "research result"
        mock_llm.assert_called_once()
        # Should post research result to bus
        mock_post.assert_called_once()

    @patch.object(aqw, "llm_execute", return_value=(True, "analysis done"))
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    def test_analysis_keyword_routes_to_llm(self, mock_pb, mock_llm):
        """Title with analysis keyword should go straight to LLM."""
        ok, msg = aqw.execute_command(*_cmd("ron", title="전략 분석 요청",
                                            body="detailed body text with enough length to trigger analysis"))
        assert ok is True
        mock_llm.assert_called_once()

    @patch.object(aqw, "run_cmd", return_value=(0, "integrity ok", ""))
    def test_ontology_check_no_analysis(self, mock_run):
        """Ontology check without analysis keywords runs ontology_core.py."""
        ok, msg = aqw.execute_command(*_cmd("ron", title="온톨로지 무결성 점검",
                                            body="simple check"))
        assert ok is True
        assert "ontology" in msg.lower()

    @patch.object(aqw, "llm_execute", return_value=(True, "llm analysis"))
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    def test_ontology_with_analysis_goes_to_llm(self, mock_pb, mock_llm):
        """Ontology + analysis keyword should route to LLM, not ontology_core."""
        ok, msg = aqw.execute_command(*_cmd("ron", title="온톨로지 분석",
                                            body="detailed body text for analysis with enough content here"))
        assert ok is True
        mock_llm.assert_called_once()

    @patch.object(aqw, "run_cmd", return_value=(0, "stats output", ""))
    def test_etf_stats_no_analysis(self, mock_run):
        """ETF/sector stats without analysis keywords runs ontology_core stats."""
        ok, msg = aqw.execute_command(*_cmd("ron", title="etf 통계",
                                            body="simple stats"))
        assert ok is True
        assert "ontology stats" in msg.lower()

    def test_cron_check(self):
        """Cron check reads jobs.json and returns count."""
        import json
        import tempfile, os
        jobs_data = {"jobs": [
            {"name": "j1", "enabled": True},
            {"name": "j2", "enabled": False},
            {"name": "j3"},  # enabled defaults to True
        ]}
        with patch.object(aqw, "WORKSPACE", Path(tempfile.mkdtemp())) as ws:
            cron_dir = ws.parent / "cron"
            cron_dir.mkdir(parents=True, exist_ok=True)
            jf = cron_dir / "jobs.json"
            jf.write_text(json.dumps(jobs_data))
            ok, msg = aqw.execute_command(*_cmd("ron", title="크론 상태 확인",
                                                body="simple check"))
            assert ok is True
            assert "3 total" in msg
            assert "2 active" in msg

    @patch.object(aqw, "llm_execute", return_value=(True, "fallback result"))
    @patch.object(aqw, "read_relevant_playbook", return_value="hint")
    def test_ron_fallback_to_llm(self, mock_pb, mock_llm):
        """Unmatched ron command falls through to LLM with playbook context."""
        ok, msg = aqw.execute_command(*_cmd("ron", title="random task",
                                            body="do something"))
        assert ok is True
        mock_llm.assert_called_once()
        # Should include playbook hint in context kwarg
        ctx_arg = mock_llm.call_args[1].get("context", "")
        assert "플레이북힌트" in ctx_arg


# ===========================================================================
# 3. CODEX AGENT ROUTING
# ===========================================================================

class TestCodexRouting:
    """Verify codex coding/non-coding rerouting and domain context."""

    @patch.object(aqw, "llm_execute", return_value=(True, "cowork result"))
    def test_non_coding_rerouted_to_cowork(self, mock_llm):
        """Codex task without any _CODING_KW → rerouted to cowork."""
        ok, msg = aqw.execute_command(*_cmd("codex", title="시스템 현황 보고",
                                            body="report about the system"))
        assert ok is True
        # First arg to llm_execute should be "cowork", not "codex"
        assert mock_llm.call_args[0][0] == "cowork"

    @patch.object(aqw, "llm_execute", return_value=(True, "codex result"))
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    def test_coding_stays_codex(self, mock_pb, mock_llm):
        """Codex task with coding keyword stays as codex."""
        ok, msg = aqw.execute_command(*_cmd("codex", title="버그 수정",
                                            body="fix the bug"))
        assert ok is True
        assert mock_llm.call_args[0][0] == "codex"

    @patch.object(aqw, "llm_execute", return_value=(True, "codex result"))
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    def test_coding_keyword_implement(self, mock_pb, mock_llm):
        ok, _ = aqw.execute_command(*_cmd("codex", title="implement feature",
                                          body="new feature"))
        assert mock_llm.call_args[0][0] == "codex"

    @patch.object(aqw, "llm_execute", return_value=(True, "codex result"))
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    def test_coding_keyword_code(self, mock_pb, mock_llm):
        ok, _ = aqw.execute_command(*_cmd("codex", title="write code for parser",
                                          body="parser code"))
        assert mock_llm.call_args[0][0] == "codex"

    @patch.object(aqw, "llm_execute", return_value=(True, "codex result"))
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    @patch.object(aqw, "run_cmd", return_value=(0, "0 syntax errors", ""))
    def test_code_quality_context_added(self, mock_run, mock_pb, mock_llm):
        """Code quality keywords trigger syntax check context."""
        ok, _ = aqw.execute_command(*_cmd("codex", title="코드 품질 검사",
                                          body="check code quality"))
        assert ok is True
        # llm_execute called with "codex" and context containing quality info
        assert mock_llm.call_args[0][0] == "codex"
        ctx = mock_llm.call_args[1].get("context", "") if "context" in (mock_llm.call_args[1] or {}) else (mock_llm.call_args[0][3] if len(mock_llm.call_args[0]) > 3 else "")
        assert "코드품질" in ctx or "syntax" in ctx.lower()

    @patch.object(aqw, "llm_execute", return_value=(True, "mcp ok"))
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    @patch.object(aqw, "run_cmd", return_value=(0, "mcp status", ""))
    def test_mcp_context_added(self, mock_run, mock_pb, mock_llm):
        """MCP keywords trigger mcp-check context."""
        ok, _ = aqw.execute_command(*_cmd("codex", title="mcp 스킬 구현",
                                          body="implement mcp skill"))
        assert ok is True
        ctx = mock_llm.call_args[1].get("context", "") if "context" in (mock_llm.call_args[1] or {}) else (mock_llm.call_args[0][3] if len(mock_llm.call_args[0]) > 3 else "")
        assert "MCP" in ctx


# ===========================================================================
# 4. COWORK AGENT ROUTING
# ===========================================================================

class TestCoworkRouting:
    """Verify cowork agent routing and context collection."""

    @patch.object(aqw, "llm_execute", return_value=(True, "cowork done"))
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    def test_cowork_basic(self, mock_pb, mock_llm):
        ok, msg = aqw.execute_command(*_cmd("cowork", title="아키텍처 설계",
                                            body="design architecture"))
        assert ok is True
        assert mock_llm.call_args[0][0] == "cowork"

    @patch.object(aqw, "llm_execute", return_value=(True, "review done"))
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    @patch.object(aqw, "jget", return_value={"agents": [{"agent": "ron", "alive": True}], "counts": {"queued": 1}})
    def test_cowork_coordination_context(self, mock_jget, mock_pb, mock_llm):
        """Coordination keywords trigger agent status context."""
        ok, _ = aqw.execute_command(*_cmd("cowork", title="에이전트 조율 리뷰",
                                          body="review agents"))
        assert ok is True
        ctx = mock_llm.call_args[1].get("context", "") if "context" in (mock_llm.call_args[1] or {}) else (mock_llm.call_args[0][3] if len(mock_llm.call_args[0]) > 3 else "")
        assert "에이전트현황" in ctx

    @patch.object(aqw, "llm_execute", return_value=(True, "evolve done"))
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    @patch.object(aqw, "run_cmd", return_value=(0, "metrics output", ""))
    def test_cowork_evolve_context(self, mock_run, mock_pb, mock_llm):
        """Evolve keywords trigger metrics context."""
        ok, _ = aqw.execute_command(*_cmd("cowork", title="진화 메트릭 점검",
                                          body="check evolution"))
        assert ok is True
        ctx = mock_llm.call_args[1].get("context", "") if "context" in (mock_llm.call_args[1] or {}) else (mock_llm.call_args[0][3] if len(mock_llm.call_args[0]) > 3 else "")
        assert "진화메트릭" in ctx


# ===========================================================================
# 5. GUARDIAN AGENT ROUTING
# ===========================================================================

class TestGuardianRouting:
    """Verify guardian system-monitoring context collection."""

    @patch.object(aqw, "llm_execute", return_value=(True, "guardian ok"))
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    @patch.object(aqw, "run_cmd", return_value=(0, "12345", ""))
    def test_guardian_process_check(self, mock_run, mock_pb, mock_llm):
        """Process keywords trigger pgrep context."""
        ok, _ = aqw.execute_command(*_cmd("guardian", title="프로세스 점검",
                                          body="check health"))
        assert ok is True
        assert mock_llm.call_args[0][0] == "guardian"
        # Should have called pgrep for Gateway, Ollama, Orchestrator
        pgrep_calls = [c for c in mock_run.call_args_list
                       if "pgrep" in c[0][0]]
        assert len(pgrep_calls) == 3

    @patch.object(aqw, "llm_execute", return_value=(True, "db ok"))
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    @patch.object(aqw, "db_connection")
    def test_guardian_db_integrity(self, mock_db_ctx, mock_pb, mock_llm):
        """DB keywords trigger integrity check context."""
        mock_conn = MagicMock()
        mock_conn.execute.side_effect = [
            MagicMock(fetchone=MagicMock(return_value=("ok",))),    # integrity
            MagicMock(fetchone=MagicMock(return_value=(100,))),     # row count
        ]
        mock_db_ctx.return_value.__enter__ = MagicMock(return_value=mock_conn)
        mock_db_ctx.return_value.__exit__ = MagicMock(return_value=False)
        ok, _ = aqw.execute_command(*_cmd("guardian", title="DB 무결성 체크",
                                          body="check database integrity"))
        assert ok is True
        ctx = mock_llm.call_args[1].get("context", "") if "context" in (mock_llm.call_args[1] or {}) else (mock_llm.call_args[0][3] if len(mock_llm.call_args[0]) > 3 else "")
        assert "DB" in ctx

    @patch.object(aqw, "llm_execute", return_value=(True, "queue ok"))
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    @patch.object(aqw, "jget", return_value={"counts": {"queued": 5, "claimed": 2, "done": 10}})
    def test_guardian_queue_check(self, mock_jget, mock_pb, mock_llm):
        """Queue keywords trigger queue status context."""
        ok, _ = aqw.execute_command(*_cmd("guardian", title="큐 상태 점검",
                                          body="check queue"))
        assert ok is True
        ctx = mock_llm.call_args[1].get("context", "") if "context" in (mock_llm.call_args[1] or {}) else (mock_llm.call_args[0][3] if len(mock_llm.call_args[0]) > 3 else "")
        assert "큐" in ctx

    @patch.object(aqw, "llm_execute", return_value=(True, "disk ok"))
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    @patch.object(aqw, "run_cmd", return_value=(0, "Filesystem  Size\n/dev/disk1  500G  200G  300G  40%  /", ""))
    def test_guardian_disk_check(self, mock_run, mock_pb, mock_llm):
        """Disk keywords trigger df -h context."""
        ok, _ = aqw.execute_command(*_cmd("guardian", title="디스크 용량",
                                          body="check disk"))
        assert ok is True
        ctx = mock_llm.call_args[1].get("context", "") if "context" in (mock_llm.call_args[1] or {}) else (mock_llm.call_args[0][3] if len(mock_llm.call_args[0]) > 3 else "")
        assert "디스크" in ctx


# ===========================================================================
# 6. DATA-ANALYST AGENT ROUTING
# ===========================================================================

class TestDataAnalystRouting:
    """Verify data-analyst context collection."""

    @patch.object(aqw, "llm_execute", return_value=(True, "analyst ok"))
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    @patch.object(aqw, "run_cmd", return_value=(0, "stats output", ""))
    def test_etf_stats_context(self, mock_run, mock_pb, mock_llm):
        """ETF keywords trigger ontology stats context."""
        ok, _ = aqw.execute_command(*_cmd("data-analyst", title="ETF 포트폴리오 분석",
                                          body="analyze etf portfolio"))
        assert ok is True
        assert mock_llm.call_args[0][0] == "data-analyst"
        ctx = mock_llm.call_args[1].get("context", "") if "context" in (mock_llm.call_args[1] or {}) else (mock_llm.call_args[0][3] if len(mock_llm.call_args[0]) > 3 else "")
        assert "OntologyStats" in ctx

    @patch.object(aqw, "llm_execute", return_value=(True, "zk ok"))
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    def test_zk_knowledge_context(self, mock_pb, mock_llm):
        """ZK keywords trigger vault count context."""
        ok, _ = aqw.execute_command(*_cmd("data-analyst", title="지식 볼트 현황",
                                          body="check knowledge vault"))
        assert ok is True
        ctx = mock_llm.call_args[1].get("context", "") if "context" in (mock_llm.call_args[1] or {}) else (mock_llm.call_args[0][3] if len(mock_llm.call_args[0]) > 3 else "")
        assert "ZK현황" in ctx

    @patch.object(aqw, "llm_execute", return_value=(True, "basic result"))
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    def test_basic_data_analyst_no_extra_context(self, mock_pb, mock_llm):
        """Task without domain keywords still routes to data-analyst LLM."""
        ok, _ = aqw.execute_command(*_cmd("data-analyst", title="general task",
                                          body="do something"))
        assert ok is True
        assert mock_llm.call_args[0][0] == "data-analyst"


# ===========================================================================
# 7. TRIAD SYNC DISPATCH
# ===========================================================================

class TestTriadSync:
    """Verify triad sync dispatches to correct agent branch."""

    @patch.object(aqw, "sync_ron_structure_brief", return_value=(True, "synced"))
    @patch.object(aqw, "read_triad_sync_snapshot", return_value={
        "digest_short": "abc12345", "directive_count": 3
    })
    def test_triad_sync_ron(self, mock_snap, mock_brief):
        ok, msg = aqw.execute_command(*_cmd("ron", title="[sync: triad]",
                                            body="공통 지시 동기화"))
        assert ok is True
        assert "triad sync applied" in msg
        assert "abc12345" in msg

    @patch.object(aqw, "read_triad_sync_snapshot", return_value={
        "digest_short": "def67890", "directive_count": 5
    })
    @patch("pathlib.Path.exists")
    def test_triad_sync_codex(self, mock_exists, mock_snap):
        # Make Path.exists return True for TRIAD_SYNC_JSON
        mock_exists.return_value = True
        ok, msg = aqw.execute_command(*_cmd("codex", title="[sync: codex]",
                                            body="공통 지시 동기화"))
        assert ok is True
        assert "codex" in msg
        assert "def67890" in msg

    @patch.object(aqw, "read_triad_sync_snapshot", return_value={
        "digest_short": "def67890", "directive_count": 5
    })
    @patch("pathlib.Path.exists")
    def test_triad_sync_codex_missing_json(self, mock_exists, mock_snap):
        """When TRIAD_SYNC_JSON is missing, codex sync fails."""
        mock_exists.return_value = False
        ok, msg = aqw.execute_command(*_cmd("codex", title="[sync: codex]",
                                            body="공통 지시 동기화"))
        assert ok is False
        assert "json missing" in msg

    @patch.object(aqw, "read_triad_sync_snapshot", return_value={
        "digest_short": "ghi11111", "directive_count": 2
    })
    def test_triad_sync_cowork(self, mock_snap):
        ok, msg = aqw.execute_command(*_cmd("cowork", title="triad sync",
                                            body="공통 지시 동기화"))
        assert ok is True
        assert "cowork" in msg
        assert "ghi11111" in msg


# ===========================================================================
# 8. UNKNOWN AGENT / FALLBACK
# ===========================================================================

class TestUnknownAgent:
    """Verify unknown agent handling."""

    def test_completely_unknown_agent(self):
        ok, msg = aqw.execute_command(*_cmd("nonexistent", title="test",
                                            body="test body"))
        assert ok is False
        assert "unknown agent" in msg

    @patch.object(aqw, "llm_execute", return_value=(True, "fallback ok"))
    def test_agent_in_model_map_but_no_branch(self, mock_llm):
        """An agent in AGENT_MODEL_MAP but without explicit branch uses LLM fallback."""
        # Temporarily add a test agent to AGENT_MODEL_MAP
        original = aqw.AGENT_MODEL_MAP.copy()
        aqw.AGENT_MODEL_MAP["test-agent"] = ["model1"]
        try:
            ok, msg = aqw.execute_command(*_cmd("test-agent", title="test",
                                                body="test body"))
            assert ok is True
            mock_llm.assert_called_once_with("test-agent", "test", "test body")
        finally:
            aqw.AGENT_MODEL_MAP.clear()
            aqw.AGENT_MODEL_MAP.update(original)


# ===========================================================================
# 9. EDGE CASES
# ===========================================================================

class TestEdgeCases:
    """Edge cases and boundary conditions."""

    @patch.object(aqw, "llm_execute", return_value=(True, "ok"))
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    def test_empty_title_valid_body(self, mock_pb, mock_llm):
        """Empty title with valid body should still route."""
        ok, _ = aqw.execute_command("ron", {"id": 1, "title": "", "body": "hello world"})
        assert ok is True

    @patch.object(aqw, "llm_execute", return_value=(True, "ok"))
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    def test_title_none_coerced(self, mock_pb, mock_llm):
        """None title should be coerced to empty string."""
        ok, _ = aqw.execute_command("ron", {"id": 1, "title": None, "body": "hello"})
        assert ok is True

    @patch.object(aqw, "llm_execute", return_value=(True, "ok"))
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    def test_body_none_coerced(self, mock_pb, mock_llm):
        """None body should be coerced to empty string (not trigger missing key)."""
        ok, _ = aqw.execute_command("ron", {"id": 1, "title": "test", "body": None})
        assert ok is True

    def test_bin_path_refused(self):
        ok, msg = aqw.execute_command("ron", {
            "id": 1, "title": "t",
            "body": "run /bin/bash -c 'echo hi'"
        })
        assert ok is False
        assert "system path" in msg

    def test_sbin_path_refused(self):
        ok, msg = aqw.execute_command("ron", {
            "id": 1, "title": "t",
            "body": "run /sbin/shutdown"
        })
        assert ok is False
        assert "system path" in msg

    @patch.object(aqw, "run_cmd", return_value=(1, "", "failed"))
    def test_ron_run_cycle_failure(self, mock_run):
        ok, msg = aqw.execute_command(*_cmd("ron", title="run-cycle"))
        assert ok is False
        assert "run-cycle failed" in msg

    @patch.object(aqw, "sync_ron_structure_brief", return_value=(False, "brief-script-missing"))
    def test_structure_brief_failure(self, mock_brief):
        ok, msg = aqw.execute_command(*_cmd("ron", title="구조 인지"))
        assert ok is False
        assert "brief-script-missing" in msg

    @patch.object(aqw, "llm_execute", return_value=(False, "llm error"))
    @patch.object(aqw, "jpost", return_value={"ok": True})
    @patch.object(aqw, "read_relevant_playbook", return_value="")
    def test_research_llm_failure_no_bus_post(self, mock_pb, mock_post, mock_llm):
        """When research LLM fails, bus post should not happen."""
        ok, msg = aqw.execute_command(*_cmd("ron", title="연구 주제"))
        assert ok is False
        mock_post.assert_not_called()
