import { describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = '/home/node/.openclaw/workspace';
const TOOLS = join(ROOT, 'tools');
const TEST_HELPER = join(ROOT, 'test/scripts/namespace-integrity/fake_pg_memory.py');

function runPy(script: string, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync('python3', [script, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
  return res;
}

function runSh(script: string, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync('bash', [script, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
  return res;
}

function setupEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-integrity-'));
  const db = join(dir, 'db.json');
  const audit = join(dir, 'audit.log');
  return {
    dir,
    db,
    audit,
    env: {
      OPENCLAW_PG_MEMORY_PATH: TEST_HELPER,
      STUB_PG_DB: db,
      OPENCLAW_NAMESPACE_AUDIT_LOG: audit,
      OPENCLAW_ACTOR_ID: 'agent:main:main',
    },
  };
}

describe('namespace integrity tooling', () => {
  test('correct write resolves active namespace when --namespace is omitted', () => {
    const t = setupEnv();

    const setActive = runPy(join(TOOLS, 'namespace_integrity.py'), ['set-active', '--namespace', 'project:alpha-lab', '--reason', 'bootstrap'], t.env);
    expect(setActive.status).toBe(0);

    const checkpoint = runPy(join(TOOLS, 'pg_checkpoint.py'), ['--completed', 'did work'], t.env);
    expect(checkpoint.status).toBe(0);

    const db = JSON.parse(readFileSync(t.db, 'utf-8'));
    const writes = db.records.filter((r: any) => r.namespace === 'project:alpha-lab' && String(r.content).includes('checkpoint ts='));
    expect(writes.length).toBe(1);
  });

  test('mismatch rejection without force', () => {
    const t = setupEnv();
    runPy(join(TOOLS, 'namespace_integrity.py'), ['set-active', '--namespace', 'project:active-a', '--reason', 'bootstrap'], t.env);

    const checkpoint = runPy(
      join(TOOLS, 'pg_checkpoint.py'),
      ['--namespace', 'project:other-b', '--completed', 'oops'],
      t.env,
    );

    expect(checkpoint.status).not.toBe(0);
    expect(checkpoint.stderr).toContain('NAMESPACE_MISMATCH');
  });

  test('forced override works with authorized actor and reason and is audited', () => {
    const t = setupEnv();
    runPy(join(TOOLS, 'namespace_integrity.py'), ['set-active', '--namespace', 'project:active-a', '--reason', 'bootstrap'], t.env);

    const checkpoint = runPy(
      join(TOOLS, 'pg_checkpoint.py'),
      [
        '--namespace',
        'project:other-b',
        '--force-cross-project',
        '--reason',
        'intentional migration checkpoint',
        '--completed',
        'forced write',
      ],
      t.env,
    );

    expect(checkpoint.status).toBe(0);
    expect(existsSync(t.audit)).toBe(true);
    const audit = readFileSync(t.audit, 'utf-8');
    expect(audit).toContain('cross_project_force_override');
  });

  test('scope switch semantics: enforce active match and do not change active on checkpoint failure', () => {
    const t = setupEnv();
    runPy(join(TOOLS, 'namespace_integrity.py'), ['set-active', '--namespace', 'project:alpha', '--reason', 'bootstrap'], t.env);

    const mismatch = runSh(join(TOOLS, 'pg_scope_switch.sh'), ['project:not-active', 'project:beta', 'handoff'], t.env);
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain('SCOPE_SWITCH_FROM_MISMATCH');

    const failedSwitch = runSh(
      join(TOOLS, 'pg_scope_switch.sh'),
      ['project:alpha', 'project:beta', 'handoff'],
      { ...t.env, STUB_FAIL_ON_STORE_NAMESPACE: 'project:alpha' },
    );
    expect(failedSwitch.status).not.toBe(0);

    const active = runPy(join(TOOLS, 'namespace_integrity.py'), ['get-active'], t.env);
    expect(active.status).toBe(0);
    const activePayload = JSON.parse(active.stdout);
    expect(activePayload.namespace).toBe('project:alpha');
  });

  test('sanitize utility runs dry-run by default and does not move records', () => {
    const t = setupEnv();

    runPy(TEST_HELPER, ['store', 'project:source', 'namespace=project:target project:target marker', '[]'], t.env);
    runPy(TEST_HELPER, ['store', 'project:source', 'mentions project:target once', '[]'], t.env);
    runPy(TEST_HELPER, ['store', 'project:source', 'unrelated content', '[]'], t.env);

    const sanitize = runPy(
      join(TOOLS, 'namespace_sanitize.py'),
      ['--source-namespace', 'project:source', '--target-namespace', 'project:target', '--query', 'project:'],
      t.env,
    );

    expect(sanitize.status).toBe(0);
    const payload = JSON.parse(sanitize.stdout);
    expect(payload.dryRun).toBe(true);
    expect(payload.counts.moved).toBe(0);
    expect(payload.counts.autoMove).toBeGreaterThanOrEqual(1);
  });
});
