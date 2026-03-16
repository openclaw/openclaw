import { describe, it, expect, vi } from 'vitest'
import { resolvePreferredOpenClawTmpDir, POSIX_OPENCLAW_TMP_DIR } from './tmp-openclaw-dir'

describe('resolvePreferredOpenClawTmpDir', () => {
  it('returns POSIX path when preferred directory exists and is accessible', () => {
    const accessSync = vi.fn()
    const statSync = vi.fn(() => ({ isDirectory: () => true }))
    const tmpdir = vi.fn(() => '/tmp')

    const result = resolvePreferredOpenClawTmpDir({
      accessSync,
      statSync,
      tmpdir,
    })

    expect(result).toBe(POSIX_OPENCLAW_TMP_DIR)
    expect(statSync).toHaveBeenCalledWith(POSIX_OPENCLAW_TMP_DIR)
    expect(accessSync).toHaveBeenCalledWith(
      POSIX_OPENCLAW_TMP_DIR,
      // fs.constants.W_OK | fs.constants.X_OK = 6
      6,
    )
  })

  it('returns fallback path when preferred directory does not exist', () => {
    const err = new Error('ENOENT: no such file or directory') as any
    err.code = 'ENOENT'
    const accessSync = vi.fn()
    const statSync = vi.fn(() => {
      throw err
    })
    const tmpdir = vi.fn(() => '/tmp')

    const result = resolvePreferredOpenClawTmpDir({
      accessSync,
      statSync,
      tmpdir,
    })

    expect(result).toBe('/tmp/openclaw')
    expect(statSync).toHaveBeenCalledWith(POSIX_OPENCLAW_TMP_DIR)
    expect(accessSync).not.toHaveBeenCalled()
  })

  it('returns fallback path when preferred directory is not a directory', () => {
    const accessSync = vi.fn()
    const statSync = vi.fn(() => ({ isDirectory: () => false }))
    const tmpdir = vi.fn(() => '/var/tmp')

    const result = resolvePreferredOpenClawTmpDir({
      accessSync,
      statSync,
      tmpdir,
    })

    expect(result).toBe('/var/tmp/openclaw')
    expect(accessSync).not.toHaveBeenCalled()
  })

  it('returns fallback path when preferred directory is not writable', () => {
    const err = new Error('EACCES: permission denied') as any
    err.code = 'EACCES'
    const accessSync = vi.fn(() => {
      throw err
    })
    const statSync = vi.fn(() => ({ isDirectory: () => true }))
    const tmpdir = vi.fn(() => '/tmp')

    const result = resolvePreferredOpenClawTmpDir({
      accessSync,
      statSync,
      tmpdir,
    })

    expect(result).toBe('/tmp/openclaw')
  })

  it('returns POSIX path when /tmp is accessible', () => {
    const err = new Error('ENOENT: no such file or directory') as any
    err.code = 'ENOENT'
    const accessSync = vi.fn((path, mode) => {
      if (path === POSIX_OPENCLAW_TMP_DIR) throw err
      // /tmp access succeeds
    })
    const statSync = vi.fn(() => {
      throw err
    })
    const tmpdir = vi.fn(() => '/tmp')

    const result = resolvePreferredOpenClawTmpDir({
      accessSync,
      statSync,
      tmpdir,
    })

    expect(result).toBe(POSIX_OPENCLAW_TMP_DIR)
  })

  it('uses default functions when options are not provided', () => {
    // This test verifies that the function can be called without options
    // and uses the real fs/os functions
    expect(() => {
      resolvePreferredOpenClawTmpDir()
    }).not.toThrow()
  })
})
