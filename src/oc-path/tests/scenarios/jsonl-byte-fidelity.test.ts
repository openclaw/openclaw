/**
 * Wave 16 — JSONL byte-fidelity round-trip.
 *
 * Substrate guarantee: `emitJsonl(parseJsonl(raw)) === raw` for every
 * input the parser accepts. JSONL is line-oriented; blanks, malformed
 * lines, mixed line endings, trailing-newline shape — all byte-stable.
 */
import { describe, expect, it } from 'vitest';
import { emitJsonl } from '../../jsonl/emit.js';
import { parseJsonl } from '../../jsonl/parse.js';

function rt(raw: string): string {
  return emitJsonl(parseJsonl(raw).ast);
}

describe('wave-16 jsonl byte-fidelity', () => {
  it('JL-01 empty file', () => {
    expect(rt('')).toBe('');
  });

  it('JL-02 single line no trailing newline', () => {
    expect(rt('{"a":1}')).toBe('{"a":1}');
  });

  it('JL-03 single line with trailing newline', () => {
    expect(rt('{"a":1}\n')).toBe('{"a":1}\n');
  });

  it('JL-04 multiple lines preserved', () => {
    const raw = '{"a":1}\n{"b":2}\n{"c":3}\n';
    expect(rt(raw)).toBe(raw);
  });

  it('JL-05 blank line in the middle preserved', () => {
    const raw = '{"a":1}\n\n{"b":2}\n';
    expect(rt(raw)).toBe(raw);
  });

  it('JL-06 multiple blank lines preserved', () => {
    const raw = '{"a":1}\n\n\n{"b":2}\n';
    expect(rt(raw)).toBe(raw);
  });

  it('JL-07 malformed line round-trips verbatim', () => {
    const raw = '{"a":1}\nthis is not json\n{"b":2}\n';
    expect(rt(raw)).toBe(raw);
  });

  it('JL-08 entirely malformed file round-trips', () => {
    const raw = 'header\nbody\nfooter\n';
    expect(rt(raw)).toBe(raw);
  });

  it('JL-09 leading + trailing blanks preserved', () => {
    const raw = '\n\n{"a":1}\n\n';
    expect(rt(raw)).toBe(raw);
  });

  it('JL-10 file ending without final newline preserved', () => {
    const raw = '{"a":1}\n{"b":2}';
    expect(rt(raw)).toBe(raw);
  });

  it('JL-11 nested object lines preserved', () => {
    const raw = '{"a":{"b":{"c":1}}}\n{"x":[1,[2,[3]]]}\n';
    expect(rt(raw)).toBe(raw);
  });

  it('JL-12 unicode in a value line preserved', () => {
    const raw = '{"name":"héllo 世界 🎉"}\n';
    expect(rt(raw)).toBe(raw);
  });

  it('JL-13 idiosyncratic whitespace inside a line preserved', () => {
    const raw = '{   "a"  :   1   }\n';
    expect(rt(raw)).toBe(raw);
  });

  it('JL-14 single blank line file preserved', () => {
    const raw = '\n';
    expect(rt(raw)).toBe(raw);
  });

  it('JL-15 large log (1000 lines) preserved', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `{"i":${i}}`);
    const raw = lines.join('\n') + '\n';
    expect(rt(raw)).toBe(raw);
  });

  it('JL-16 mixed value + malformed + blank preserved', () => {
    const raw =
      '{"a":1}\n{not json}\n\n{"b":2}\nstill not json\n{"c":3}\n';
    expect(rt(raw)).toBe(raw);
  });
});
