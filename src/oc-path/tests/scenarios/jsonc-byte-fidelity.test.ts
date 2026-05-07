/**
 * Wave 15 — JSONC byte-fidelity round-trip.
 *
 * Substrate guarantee: `emitJsonc(parseJsonc(raw)) === raw` for every
 * input the parser accepts. Mirrors wave-01 but for the JSONC kind.
 * Comments, trailing commas, BOMs, mixed line endings — all byte-stable
 * via the round-trip path.
 */
import { describe, expect, it } from 'vitest';
import { emitJsonc } from '../../jsonc/emit.js';
import { parseJsonc } from '../../jsonc/parse.js';

function rt(raw: string): string {
  return emitJsonc(parseJsonc(raw).ast);
}

describe('wave-15 jsonc byte-fidelity', () => {
  it('JC-01 empty file', () => {
    expect(rt('')).toBe('');
  });

  it('JC-02 whitespace-only', () => {
    expect(rt('   \n\n   \n')).toBe('   \n\n   \n');
  });

  it('JC-03 empty object', () => {
    expect(rt('{}')).toBe('{}');
  });

  it('JC-04 empty array', () => {
    expect(rt('[]')).toBe('[]');
  });

  it('JC-05 trivial scalar root', () => {
    expect(rt('42')).toBe('42');
    expect(rt('"x"')).toBe('"x"');
    expect(rt('true')).toBe('true');
    expect(rt('null')).toBe('null');
  });

  it('JC-06 line comments preserved', () => {
    const raw = '// a leading comment\n{ "x": 1 } // trailing\n';
    expect(rt(raw)).toBe(raw);
  });

  it('JC-07 block comments preserved', () => {
    const raw = '/* header */\n{\n  /* inline */\n  "x": 1\n}\n';
    expect(rt(raw)).toBe(raw);
  });

  it('JC-08 trailing commas preserved', () => {
    const raw = '{\n  "x": 1,\n  "y": 2,\n}';
    expect(rt(raw)).toBe(raw);
  });

  it('JC-09 mixed CRLF + LF preserved', () => {
    const raw = '{\r\n  "x": 1,\n  "y": 2\r\n}';
    expect(rt(raw)).toBe(raw);
  });

  it('JC-10 BOM preserved on raw', () => {
    const raw = '﻿{ "x": 1 }';
    expect(rt(raw)).toBe(raw);
  });

  it('JC-11 deeply nested structures preserved', () => {
    const raw = '{ "a": { "b": { "c": { "d": [1, [2, [3, [4]]]] } } } }';
    expect(rt(raw)).toBe(raw);
  });

  it('JC-12 string with escape sequences preserved', () => {
    const raw = '{ "s": "a\\nb\\tc\\u0041\\\\d\\"e" }';
    expect(rt(raw)).toBe(raw);
  });

  it('JC-13 numbers in scientific / negative / decimal forms preserved', () => {
    const raw = '[ 0, -0, 1.5, -3.14, 1e3, -2.5e-10, 1E+5 ]';
    expect(rt(raw)).toBe(raw);
  });

  it('JC-14 unicode characters preserved verbatim', () => {
    const raw = '{ "name": "héllo 世界 🎉" }';
    expect(rt(raw)).toBe(raw);
  });

  it('JC-15 idiosyncratic whitespace preserved', () => {
    const raw = '{    "x"   :     1    ,\n   "y":   2}';
    expect(rt(raw)).toBe(raw);
  });

  it('JC-16 file-level trailing whitespace preserved', () => {
    const raw = '{ "x": 1 }\n\n\n';
    expect(rt(raw)).toBe(raw);
  });

  it('JC-17 malformed input still emits raw verbatim', () => {
    const raw = '{ broken json with "key": value }';
    expect(rt(raw)).toBe(raw);
  });

  it('JC-18 comments-only file preserved', () => {
    const raw = '// just a comment\n/* and a block */\n';
    expect(rt(raw)).toBe(raw);
  });
});
