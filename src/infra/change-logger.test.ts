/**
 * Tests for the change-logger module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  initChangeLogger,
  logChangeEntry,
  logFileCreate,
  logFileModify,
  logFileDelete,
  formatChangeEntry,
  getCurrentMonthLogPath,
  getChangeLogDir,
  readRecentEntries,
  getChangeStats,
  type ChangeLogEntry,
  type AgentId,
} from './change-logger.js';

describe('change-logger', () => {
  let tempDir: string;
  let myVaultPath: string;

  beforeEach(async () => {
    // Create a temporary directory for testing
    tempDir = await mkdtemp(join(tmpdir(), 'change-logger-test-'));
    myVaultPath = join(tempDir, 'myVault');
    await mkdir(join(myVaultPath, '15_ChangeLogs'), { recursive: true });

    // Initialize the logger with test paths
    initChangeLogger({
      myVaultPath,
      sessionId: 'test-session-123',
    });
  });

  afterEach(async () => {
    // Clean up temp directory
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('formatChangeEntry', () => {
    it('should format a basic entry correctly', () => {
      const entry: ChangeLogEntry = {
        timestamp: '2026-03-04T18:30:00Z',
        agent: 'kilo-code' as AgentId,
        sessionId: 'test-session',
        file: 'src/app.ts',
        operation: 'modify',
        project: 'openclaw',
        reason: 'Fixed bug',
      };

      const formatted = formatChangeEntry(entry);

      expect(formatted).toContain('[2026-03-04T18:30:00Z]');
      expect(formatted).toContain('kilo-code');
      expect(formatted).toContain('MODIFY');
      expect(formatted).toContain('src/app.ts');
      expect(formatted).toContain('Fixed bug');
    });

    it('should include line numbers when provided', () => {
      const entry: ChangeLogEntry = {
        timestamp: '2026-03-04T18:30:00Z',
        agent: 'kilo-code' as AgentId,
        sessionId: 'test-session',
        file: 'src/app.ts',
        operation: 'modify',
        lines: { start: 10, end: 25 },
        project: 'openclaw',
        reason: 'Fixed bug',
      };

      const formatted = formatChangeEntry(entry);

      expect(formatted).toContain('(lines 10-25)');
    });

    it('should include metadata when provided', () => {
      const entry: ChangeLogEntry = {
        timestamp: '2026-03-04T18:30:00Z',
        agent: 'openclaw' as AgentId,
        sessionId: 'test-session',
        file: 'src/app.ts',
        operation: 'create',
        project: 'openclaw',
        reason: 'Added new feature',
        metadata: {
          commitHash: 'abc123',
          issueRef: '#123',
          tags: ['feature'],
        },
      };

      const formatted = formatChangeEntry(entry);

      expect(formatted).toContain('Metadata:');
      expect(formatted).toContain('abc123');
    });
  });

  describe('logChangeEntry', () => {
    it('should write an entry to the change log', async () => {
      await logChangeEntry({
        agent: 'kilo-code',
        file: 'src/test.ts',
        operation: 'create',
        project: 'test-project',
        reason: 'Test entry',
      });

      const logPath = getCurrentMonthLogPath();
      const content = await readFile(logPath, 'utf-8');

      expect(content).toContain('kilo-code');
      expect(content).toContain('src/test.ts');
      expect(content).toContain('CREATE');
      expect(content).toContain('Test entry');
      expect(content).toContain('test-project');
    });

    it('should create the change log file if it does not exist', async () => {
      // Remove the directory to simulate first run
      const changeLogDir = getChangeLogDir();
      await rm(changeLogDir, { recursive: true, force: true });

      await logChangeEntry({
        agent: 'codex',
        file: 'src/new.ts',
        operation: 'create',
        project: 'new-project',
        reason: 'New file',
      });

      const logPath = getCurrentMonthLogPath();
      const content = await readFile(logPath, 'utf-8');

      expect(content).toContain('# Change Log');
      expect(content).toContain('codex');
    });
  });

  describe('convenience functions', () => {
    it('logFileCreate should create a CREATE entry', async () => {
      await logFileCreate(
        'openclaw',
        'src/new.ts',
        'openclaw',
        'Created new module',
      );

      const logPath = getCurrentMonthLogPath();
      const content = await readFile(logPath, 'utf-8');

      expect(content).toContain('CREATE');
      expect(content).toContain('src/new.ts');
    });

    it('logFileModify should create a MODIFY entry with lines', async () => {
      await logFileModify(
        'kilo-code',
        'src/existing.ts',
        'openclaw',
        'Fixed bug',
        { start: 5, end: 10 },
      );

      const logPath = getCurrentMonthLogPath();
      const content = await readFile(logPath, 'utf-8');

      expect(content).toContain('MODIFY');
      expect(content).toContain('(lines 5-10)');
    });

    it('logFileDelete should create a DELETE entry', async () => {
      await logFileDelete(
        'codex',
        'src/old.ts',
        'openclaw',
        'Removed deprecated code',
      );

      const logPath = getCurrentMonthLogPath();
      const content = await readFile(logPath, 'utf-8');

      expect(content).toContain('DELETE');
      expect(content).toContain('src/old.ts');
    });
  });

  describe('readRecentEntries', () => {
    it('should return empty array when no entries exist', async () => {
      const entries = await readRecentEntries();
      expect(entries).toEqual([]);
    });

    it('should parse entries from the log file', async () => {
      await logChangeEntry({
        agent: 'kilo-code',
        file: 'src/file1.ts',
        operation: 'create',
        project: 'test',
        reason: 'First file',
      });

      await logChangeEntry({
        agent: 'openclaw',
        file: 'src/file2.ts',
        operation: 'modify',
        lines: { start: 10, end: 20 },
        project: 'test',
        reason: 'Second file',
      });

      const entries = await readRecentEntries();

      expect(entries).toHaveLength(2);
      expect(entries[0].agent).toBe('openclaw');
      expect(entries[0].file).toBe('src/file2.ts');
      expect(entries[1].agent).toBe('kilo-code');
    });
  });

  describe('getChangeStats', () => {
    it('should return stats for all entries', async () => {
      await logChangeEntry({
        agent: 'kilo-code',
        file: 'src/a.ts',
        operation: 'create',
        project: 'test',
        reason: 'Create',
      });

      await logChangeEntry({
        agent: 'kilo-code',
        file: 'src/b.ts',
        operation: 'modify',
        project: 'test',
        reason: 'Modify',
      });

      await logChangeEntry({
        agent: 'codex',
        file: 'src/c.ts',
        operation: 'delete',
        project: 'test',
        reason: 'Delete',
      });

      const stats = await getChangeStats();

      expect(stats.total).toBe(3);
      expect(stats.byAgent['kilo-code']).toBe(2);
      expect(stats.byAgent['codex']).toBe(1);
      expect(stats.byOperation['create']).toBe(1);
      expect(stats.byOperation['modify']).toBe(1);
      expect(stats.byOperation['delete']).toBe(1);
    });
  });
});
