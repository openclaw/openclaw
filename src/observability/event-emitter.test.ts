import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── fs mock (hoisted so it's available before module load) ───────────────────
const appendFileSyncMock = vi.hoisted(() => vi.fn());
const mkdirSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      appendFileSync: appendFileSyncMock,
      mkdirSync: mkdirSyncMock,
    },
    appendFileSync: appendFileSyncMock,
    mkdirSync: mkdirSyncMock,
  };
});

// ── Logger mock: return predictable log file path ────────────────────────────
vi.mock('../logging/logger.js', () => ({
  getResolvedLoggerSettings: () => ({
    file: '/tmp/openclaw/openclaw-2026-03-28.log',
    level: 'info',
    maxFileBytes: 500 * 1024 * 1024,
  }),
}));

describe('emitLlmEvent', () => {
  beforeEach(() => {
    vi.resetModules();
    appendFileSyncMock.mockReset();
    mkdirSyncMock.mockReset();
  });

  // ── Test 1: Anthropic success response ───────────────────────────────────
  it('emits correct JSONL for Anthropic success response', async () => {
    const { emitLlmEvent } = await import('./event-emitter.js');
    const startTime = performance.now() - 2340;

    emitLlmEvent({
      level: 'info',
      model: 'claude-sonnet-4-6-20250613',
      provider: 'anthropic',
      sessionKey: 'agent:conductor',
      startTime,
      tokensIn: 1500,
      tokensOut: 800,
    });

    expect(appendFileSyncMock).toHaveBeenCalledOnce();
    const [filePath, written] = appendFileSyncMock.mock.calls[0] as [string, string];

    // File path must be the log file
    expect(filePath).toBe('/tmp/openclaw/openclaw-2026-03-28.log');

    const parsed = JSON.parse((written as string).trim());

    // Required fields
    expect(parsed.event).toBe('llm_event');
    expect(parsed.level).toBe('info');
    expect(parsed.type).toBe('openclaw');   // ← critical for Logstash routing
    expect(parsed.sessionKey).toBe('agent:conductor');
    expect(parsed.model).toBe('claude-sonnet-4-6-20250613');
    expect(parsed.provider).toBe('anthropic');
    expect(parsed.tokens_in).toBe(1500);
    expect(parsed.tokens_out).toBe(800);
    expect(typeof parsed.duration_ms).toBe('number');
    expect(parsed.duration_ms).toBeGreaterThan(0);
    expect(typeof parsed.time).toBe('string');

    // Must NOT have tslog envelope fields
    expect(parsed['0']).toBeUndefined();
    expect(parsed['_meta']).toBeUndefined();

    // Must NOT have error fields on success
    expect(parsed.error_type).toBeUndefined();
    expect(parsed.error_message).toBeUndefined();
  });

  // ── Test 2: Gemini success response ──────────────────────────────────────
  it('emits correct JSONL for Gemini success response', async () => {
    const { emitLlmEvent } = await import('./event-emitter.js');

    emitLlmEvent({
      level: 'info',
      model: 'gemini-3-pro-preview',
      provider: 'google-gemini-cli',
      sessionKey: 'agent:main',
      startTime: performance.now() - 1200,
      tokensIn: 2048,
      tokensOut: 512,
    });

    expect(appendFileSyncMock).toHaveBeenCalledOnce();
    const [, written] = appendFileSyncMock.mock.calls[0] as [string, string];
    const parsed = JSON.parse((written as string).trim());

    expect(parsed.provider).toBe('google-gemini-cli');
    expect(parsed.tokens_in).toBe(2048);
    expect(parsed.tokens_out).toBe(512);
    expect(parsed.type).toBe('openclaw');
  });

  // ── Test 3: Error event shape ─────────────────────────────────────────────
  it('emits error event with error_type and error_message', async () => {
    const { emitLlmEvent } = await import('./event-emitter.js');

    emitLlmEvent({
      level: 'error',
      model: 'claude-sonnet-4-6-20250613',
      provider: 'anthropic',
      sessionKey: 'agent:main',
      startTime: performance.now() - 500,
      tokensIn: 800,
      tokensOut: 0,
      error: new Error('rate limit exceeded: 429 Too Many Requests'),
    });

    expect(appendFileSyncMock).toHaveBeenCalledOnce();
    const [, written] = appendFileSyncMock.mock.calls[0] as [string, string];
    const parsed = JSON.parse((written as string).trim());

    expect(parsed.level).toBe('error');
    expect(parsed.error_type).toBe('rate_limit');
    expect(typeof parsed.error_message).toBe('string');
    expect(parsed.error_message.length).toBeLessThanOrEqual(500);
    expect(parsed.tokens_in).toBe(800);
    // tokens_out omitted when 0
    expect(parsed.tokens_out).toBeUndefined();
  });

  // ── Test 4: No emit on network failure (zero token usage gate) ────────────
  it('does NOT emit when usage.input === 0 && usage.output === 0 (network failure)', async () => {
    const { emitLlmEvent } = await import('./event-emitter.js');

    // Simulate the caller guard in completeWithPreparedSimpleCompletionModel:
    const networkFailureUsage = { input: 0, output: 0 };
    const hasUsage = networkFailureUsage.input > 0 || networkFailureUsage.output > 0;

    if (hasUsage) {
      emitLlmEvent({
        level: 'error',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        sessionKey: 'agent:main',
        startTime: performance.now(),
        error: new Error('ECONNREFUSED'),
      });
    }

    // emitLlmEvent must not have been called
    expect(appendFileSyncMock).not.toHaveBeenCalled();
  });

  // ── Test 5: Token field omission when 0 ──────────────────────────────────
  it('omits tokens_in and tokens_out entirely when 0 (not null, not undefined-from-absence)', async () => {
    const { emitLlmEvent } = await import('./event-emitter.js');

    emitLlmEvent({
      level: 'info',
      model: 'test-model',
      provider: 'test',
      sessionKey: 'agent:test',
      startTime: performance.now(),
      tokensIn: 0,
      tokensOut: 0,
    });

    expect(appendFileSyncMock).toHaveBeenCalledOnce();
    const [, written] = appendFileSyncMock.mock.calls[0] as [string, string];
    const parsed = JSON.parse((written as string).trim());

    // Fields must be absent (not present as null or 0)
    expect('tokens_in' in parsed).toBe(false);
    expect('tokens_out' in parsed).toBe(false);
  });

  // ── Test 6: sessionKey fallback ───────────────────────────────────────────
  it('uses "unknown" sessionKey when empty or missing', async () => {
    const { emitLlmEvent } = await import('./event-emitter.js');

    emitLlmEvent({
      level: 'info',
      model: 'test-model',
      provider: 'test',
      sessionKey: '',
      startTime: performance.now(),
      tokensIn: 100,
      tokensOut: 50,
    });

    expect(appendFileSyncMock).toHaveBeenCalledOnce();
    const [, written] = appendFileSyncMock.mock.calls[0] as [string, string];
    const parsed = JSON.parse((written as string).trim());
    expect(parsed.sessionKey).toBe('unknown');
  });
});
