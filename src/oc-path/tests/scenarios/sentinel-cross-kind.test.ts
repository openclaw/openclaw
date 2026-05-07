/**
 * Wave 21 — sentinel guard across all 3 kinds.
 *
 * Substrate guarantee: `__OPENCLAW_REDACTED__` literal in any emitted
 * byte sequence throws OcEmitSentinelError. The guard runs in BOTH
 * round-trip (scans raw) and render mode (walks every leaf). This is
 * the substrate's defense against accidentally writing a redacted view
 * to disk.
 */
import { describe, expect, it } from 'vitest';
import { setJsoncOcPath } from '../../jsonc/edit.js';
import { emitMd } from '../../emit.js';
import { emitJsonc } from '../../jsonc/emit.js';
import { parseJsonc } from '../../jsonc/parse.js';
import { emitJsonl } from '../../jsonl/emit.js';
import { parseJsonl } from '../../jsonl/parse.js';
import { parseOcPath } from '../../oc-path.js';
import { parseMd } from '../../parse.js';
import {
  OcEmitSentinelError,
  REDACTED_SENTINEL,
} from '../../sentinel.js';

describe('wave-21 sentinel guard cross-kind', () => {
  it('S-01 jsonc round-trip throws when raw contains the sentinel', () => {
    const raw = `{ "x": "${REDACTED_SENTINEL}" }`;
    const ast = parseJsonc(raw).ast;
    expect(() => emitJsonc(ast)).toThrow(OcEmitSentinelError);
  });

  it('S-02 jsonl round-trip throws when raw contains the sentinel', () => {
    const raw = `{"x":"${REDACTED_SENTINEL}"}\n`;
    const ast = parseJsonl(raw).ast;
    expect(() => emitJsonl(ast)).toThrow(OcEmitSentinelError);
  });

  it('S-03 md round-trip throws when raw contains the sentinel', () => {
    const raw = `## Body\n\n- ${REDACTED_SENTINEL}\n`;
    const ast = parseMd(raw).ast;
    expect(() => emitMd(ast)).toThrow(OcEmitSentinelError);
  });

  it('S-04 jsonc render mode walks every leaf for sentinel', () => {
    const ast = parseJsonc('{ "x": "ok" }').ast;
    const tampered = {
      ...ast,
      root: {
        kind: 'object' as const,
        entries: [
          {
            key: 'x',
            line: 1,
            value: { kind: 'string' as const, value: REDACTED_SENTINEL },
          },
        ],
      },
    };
    expect(() => emitJsonc(tampered, { mode: 'render' })).toThrow(
      OcEmitSentinelError,
    );
  });

  it('S-05 jsonl render mode walks every value-line leaf', () => {
    const ast = parseJsonl('{"a":"ok"}\n').ast;
    const tampered = {
      ...ast,
      lines: [
        {
          kind: 'value' as const,
          line: 1,
          raw: '{"a":"ok"}',
          value: {
            kind: 'object' as const,
            entries: [
              {
                key: 'a',
                line: 1,
                value: { kind: 'string' as const, value: REDACTED_SENTINEL },
              },
            ],
          },
        },
      ],
    };
    expect(() => emitJsonl(tampered, { mode: 'render' })).toThrow(
      OcEmitSentinelError,
    );
  });

  it('S-06 setJsoncOcPath itself throws when the new value contains the sentinel', () => {
    // The substrate guard fires at write-time: setJsoncOcPath rebuilds
    // raw via render mode emit, which scans every leaf. Defense-in-depth
    // — even if a caller forgets to call emit afterward, the sentinel
    // can't make it into an in-memory AST that pretends to be valid.
    const ast = parseJsonc('{ "x": "ok" }').ast;
    expect(() =>
      setJsoncOcPath(ast, parseOcPath('oc://config/x'), {
        kind: 'string',
        value: REDACTED_SENTINEL,
      }),
    ).toThrow(OcEmitSentinelError);
  });

  it('S-07 sentinel embedded in deep nesting still triggers guard', () => {
    const raw = JSON.stringify({ a: { b: { c: REDACTED_SENTINEL } } });
    const ast = parseJsonc(raw).ast;
    expect(() => emitJsonc(ast)).toThrow(OcEmitSentinelError);
  });

  it('S-08 sentinel inside an array element triggers guard in render mode', () => {
    const raw = JSON.stringify({ arr: ['ok', REDACTED_SENTINEL, 'ok'] });
    const ast = parseJsonc(raw).ast;
    expect(() => emitJsonc(ast, { mode: 'render' })).toThrow(OcEmitSentinelError);
  });

  it('S-09 sentinel as object key (not value) in raw triggers round-trip guard', () => {
    const raw = `{ "${REDACTED_SENTINEL}": 1 }`;
    const ast = parseJsonc(raw).ast;
    expect(() => emitJsonc(ast)).toThrow(OcEmitSentinelError);
  });

  it('S-10 sentinel in jsonl malformed line still triggers guard', () => {
    const raw = `${REDACTED_SENTINEL}\n`;
    const ast = parseJsonl(raw).ast;
    expect(() => emitJsonl(ast)).toThrow(OcEmitSentinelError);
  });

  it('S-11 partial sentinel substring does NOT trigger guard', () => {
    const raw = '{ "x": "OPENCLAW_REDACTED" }';
    const ast = parseJsonc(raw).ast;
    expect(() => emitJsonc(ast)).not.toThrow();
  });

  it('S-12 sentinel guard error message includes the OcPath context', () => {
    const raw = `{ "secret": "${REDACTED_SENTINEL}" }`;
    const ast = parseJsonc(raw).ast;
    try {
      emitJsonc(ast, { fileNameForGuard: 'config' });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OcEmitSentinelError);
      expect(String(e)).toContain('oc://');
    }
  });
});
