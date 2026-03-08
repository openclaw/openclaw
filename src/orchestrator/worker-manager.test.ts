/**
 * Worker Manager 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerManager, type WorkerInfo, type WorkerStatus } from './worker-manager.js';

describe('WorkerManager', () => {
  let manager: WorkerManager;

  beforeEach(() => {
    manager = new WorkerManager({
      maxWorkers: 10,
      heartbeatTimeout: 30000,
    });
  });

  afterEach(() => {
    manager.stop();
  });

  describe('registerWorker', () => {
    it('should register a new worker', async () => {
      const workerInfo: Partial<WorkerInfo> = {
        id: 'worker_001',
        url: 'http://worker1:3000',
        capabilities: ['code-review', 'file-ops'],
      };

      await manager.registerWorker(workerInfo);

      const workers = manager.getWorkers();
      expect(workers.length).toBe(1);
      expect(workers[0].id).toBe('worker_001');
      expect(workers[0].status).toBe('idle');
    });

    it('should reject duplicate worker registration', async () => {
      const workerInfo: Partial<WorkerInfo> = {
        id: 'worker_001',
        url: 'http://worker1:3000',
      };

      await manager.registerWorker(workerInfo);

      await expect(manager.registerWorker(workerInfo)).rejects.toThrow(
        'Worker worker_001 already registered'
      );
    });

    it('should reject registration when max workers reached', async () => {
      const smallManager = new WorkerManager({ maxWorkers: 2 });

      await smallManager.registerWorker({ id: 'w1', url: 'http://w1:3000' });
      await smallManager.registerWorker({ id: 'w2', url: 'http://w2:3000' });

      await expect(
        smallManager.registerWorker({ id: 'w3', url: 'http://w3:3000' })
      ).rejects.toThrow('Maximum worker limit reached');

      smallManager.stop();
    });
  });

  describe('unregisterWorker', () => {
    it('should unregister a worker', async () => {
      await manager.registerWorker({ id: 'worker_001', url: 'http://worker1:3000' });

      await manager.unregisterWorker('worker_001');

      const workers = manager.getWorkers();
      expect(workers.length).toBe(0);
    });

    it('should throw error when unregistering non-existent worker', async () => {
      await expect(manager.unregisterWorker('non_existent')).rejects.toThrow(
        'Worker non_existent not found'
      );
    });
  });

  describe('updateWorkerStatus', () => {
    it('should update worker status via heartbeat', async () => {
      await manager.registerWorker({ id: 'worker_001', url: 'http://worker1:3000' });

      await manager.updateWorkerStatus('worker_001', {
        status: 'busy',
        currentTaskId: 'task_123',
        resourceUsage: {
          cpu: 50,
          memory: 1024,
          disk: 2048,
        },
      });

      const worker = manager.getWorker('worker_001');
      expect(worker!.status).toBe('busy');
      expect(worker!.currentTaskId).toBe('task_123');
      expect(worker!.resourceUsage.cpu).toBe(50);
    });
  });

  describe('assignTask', () => {
    it('should assign task to idle worker', async () => {
      await manager.registerWorker({
        id: 'worker_001',
        url: 'http://worker1:3000',
        capabilities: ['code-review'],
      });

      const assignment = await manager.assignTask({
        taskId: 'task_123',
        requiredCapabilities: ['code-review'],
      });

      expect(assignment).not.toBeNull();
      expect(assignment!.workerId).toBe('worker_001');
    });

    it('should assign task to worker with matching capabilities', async () => {
      await manager.registerWorker({
        id: 'worker_001',
        url: 'http://worker1:3000',
        capabilities: ['code-review'],
      });
      await manager.registerWorker({
        id: 'worker_002',
        url: 'http://worker2:3000',
        capabilities: ['data-analysis'],
      });

      const assignment = await manager.assignTask({
        taskId: 'task_456',
        requiredCapabilities: ['data-analysis'],
      });

      expect(assignment!.workerId).toBe('worker_002');
    });

    it('should return null when no suitable worker found', async () => {
      await manager.registerWorker({
        id: 'worker_001',
        url: 'http://worker1:3000',
        capabilities: ['code-review'],
      });

      const assignment = await manager.assignTask({
        taskId: 'task_789',
        requiredCapabilities: ['data-analysis'],
      });

      expect(assignment).toBeNull();
    });

    it('should not assign task to busy worker', async () => {
      await manager.registerWorker({ id: 'worker_001', url: 'http://worker1:3000' });

      // Mark worker as busy
      await manager.updateWorkerStatus('worker_001', {
        status: 'busy',
        currentTaskId: 'existing_task',
      });

      const assignment = await manager.assignTask({
        taskId: 'new_task',
      });

      expect(assignment).toBeNull();
    });
  });

  describe('getAvailableWorkers', () => {
    it('should return only idle workers', async () => {
      await manager.registerWorker({ id: 'w1', url: 'http://w1:3000' });
      await manager.registerWorker({ id: 'w2', url: 'http://w2:3000' });
      await manager.registerWorker({ id: 'w3', url: 'http://w3:3000' });

      // Mark w2 as busy
      await manager.updateWorkerStatus('w2', { status: 'busy' });

      const available = manager.getAvailableWorkers();
      expect(available.length).toBe(2);
      expect(available.map(w => w.id)).toEqual(expect.arrayContaining(['w1', 'w3']));
    });

    it('should filter workers by capability', async () => {
      await manager.registerWorker({
        id: 'w1',
        url: 'http://w1:3000',
        capabilities: ['code-review', 'file-ops'],
      });
      await manager.registerWorker({
        id: 'w2',
        url: 'http://w2:3000',
        capabilities: ['data-analysis'],
      });

      const available = manager.getAvailableWorkers(['code-review']);
      expect(available.length).toBe(1);
      expect(available[0].id).toBe('w1');
    });
  });

  describe('detectStaleWorkers', () => {
    it('should detect workers that missed heartbeat', async () => {
      vi.useFakeTimers();

      await manager.registerWorker({ id: 'worker_001', url: 'http://worker1:3000' });

      // Simulate heartbeat
      await manager.updateWorkerStatus('worker_001', { status: 'idle' });

      // Advance time beyond heartbeat timeout
      vi.advanceTimersByTime(35000);

      const staleWorkers = manager.detectStaleWorkers();
      expect(staleWorkers.length).toBe(1);
      expect(staleWorkers[0].id).toBe('worker_001');

      vi.useRealTimers();
    });

    it('should not detect healthy workers as stale', async () => {
      vi.useFakeTimers();

      await manager.registerWorker({ id: 'worker_001', url: 'http://worker1:3000' });
      await manager.updateWorkerStatus('worker_001', { status: 'idle' });

      // Advance time but not beyond timeout
      vi.advanceTimersByTime(20000);

      const staleWorkers = manager.detectStaleWorkers();
      expect(staleWorkers.length).toBe(0);

      vi.useRealTimers();
    });
  });

  describe('getWorkerStats', () => {
    it('should return worker statistics', async () => {
      await manager.registerWorker({ id: 'w1', url: 'http://w1:3000' });
      await manager.registerWorker({ id: 'w2', url: 'http://w2:3000' });
      await manager.registerWorker({ id: 'w3', url: 'http://w3:3000' });

      await manager.updateWorkerStatus('w1', { status: 'busy' });
      await manager.updateWorkerStatus('w2', { status: 'busy' });

      const stats = manager.getWorkerStats();

      expect(stats.totalWorkers).toBe(3);
      expect(stats.idleWorkers).toBe(1);
      expect(stats.busyWorkers).toBe(2);
      expect(stats.utilization).toBeCloseTo(66.67, 1);
    });
  });

  describe('load balancing strategies', () => {
    it('should use round-robin when multiple workers available', async () => {
      await manager.registerWorker({ id: 'w1', url: 'http://w1:3000' });
      await manager.registerWorker({ id: 'w2', url: 'http://w2:3000' });

      const assignment1 = await manager.assignTask({ taskId: 't1' });
      const assignment2 = await manager.assignTask({ taskId: 't2' });

      // Should assign to different workers
      expect(assignment1!.workerId).not.toBe(assignment2!.workerId);
    });

    it('should prefer workers with lower resource usage', async () => {
      await manager.registerWorker({ id: 'w1', url: 'http://w1:3000' });
      await manager.registerWorker({ id: 'w2', url: 'http://w2:3000' });

      // w1 has high CPU usage
      await manager.updateWorkerStatus('w1', {
        status: 'idle',
        resourceUsage: { cpu: 90, memory: 2048, disk: 1024 },
      });

      // w2 has low CPU usage
      await manager.updateWorkerStatus('w2', {
        status: 'idle',
        resourceUsage: { cpu: 10, memory: 512, disk: 512 },
      });

      const assignment = await manager.assignTask({ taskId: 't1' });

      // Should prefer w2 (lower resource usage)
      expect(assignment!.workerId).toBe('w2');
    });
  });
});
