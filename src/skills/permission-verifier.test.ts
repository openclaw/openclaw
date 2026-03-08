/**
 * 技能权限验证器单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SkillPermissionVerifier,
  type SkillPermission,
  type SkillAuthorizationResult,
} from './permission-verifier.js';

describe('SkillPermissionVerifier', () => {
  let verifier: SkillPermissionVerifier;
  let mockPlatformClient: any;

  beforeEach(() => {
    // Mock ClawForge 平台客户端
    mockPlatformClient = {
      getOrganizationSkills: vi.fn(),
      verifySkillPermission: vi.fn(),
      getSkillTrialStatus: vi.fn(),
    };

    verifier = new SkillPermissionVerifier({
      orgId: 'org_test123',
      userId: 'user_abc456',
      platformClient: mockPlatformClient,
    });
  });

  describe('loadOrganizationSkills', () => {
    it('should load skills for organization', async () => {
      const mockSkills = [
        { id: 'skill_1', name: 'Code Review', status: 'active' },
        { id: 'skill_2', name: 'Data Analysis', status: 'active' },
      ];

      mockPlatformClient.getOrganizationSkills.mockResolvedValue(mockSkills);

      const skills = await verifier.loadOrganizationSkills();

      expect(mockPlatformClient.getOrganizationSkills).toHaveBeenCalledWith('org_test123');
      expect(skills.length).toBe(2);
      expect(skills.map(s => s.id)).toEqual(['skill_1', 'skill_2']);
    });

    it('should handle empty skill list', async () => {
      mockPlatformClient.getOrganizationSkills.mockResolvedValue([]);

      const skills = await verifier.loadOrganizationSkills();

      expect(skills.length).toBe(0);
    });

    it('should cache loaded skills', async () => {
      mockPlatformClient.getOrganizationSkills.mockResolvedValue([
        { id: 'skill_1', name: 'Test Skill', status: 'active' },
      ]);

      await verifier.loadOrganizationSkills();
      await verifier.loadOrganizationSkills();

      // Should only call API once (cached)
      expect(mockPlatformClient.getOrganizationSkills).toHaveBeenCalledTimes(1);
    });

    it('should refresh cache when forced', async () => {
      mockPlatformClient.getOrganizationSkills.mockResolvedValue([
        { id: 'skill_1', name: 'Test Skill', status: 'active' },
      ]);

      await verifier.loadOrganizationSkills();
      await verifier.loadOrganizationSkills(true); // force refresh

      expect(mockPlatformClient.getOrganizationSkills).toHaveBeenCalledTimes(2);
    });
  });

  describe('verifySkillPermission', () => {
    it('should authorize skill if organization has permission', async () => {
      mockPlatformClient.getOrganizationSkills.mockResolvedValue([
        { id: 'skill_123', name: 'Test Skill', status: 'active' },
      ]);

      const result = await verifier.verifySkillPermission('skill_123');

      expect(result.authorized).toBe(true);
      expect(result.reason).toBe('Skill authorized for organization');
    });

    it('should deny skill if organization does not have permission', async () => {
      mockPlatformClient.getOrganizationSkills.mockResolvedValue([
        { id: 'skill_456', name: 'Other Skill', status: 'active' },
      ]);

      const result = await verifier.verifySkillPermission('skill_789');

      expect(result.authorized).toBe(false);
      expect(result.reason).toContain('not authorized');
    });

    it('should deny skill if organization has no skills', async () => {
      mockPlatformClient.getOrganizationSkills.mockResolvedValue([]);

      const result = await verifier.verifySkillPermission('skill_123');

      expect(result.authorized).toBe(false);
    });

    it('should check trial status for trial skills', async () => {
      mockPlatformClient.getOrganizationSkills.mockResolvedValue([
        {
          id: 'skill_trial',
          name: 'Trial Skill',
          status: 'trial',
          trialExpiresAt: Date.now() + 86400000, // 1 day in future
        },
      ]);

      const result = await verifier.verifySkillPermission('skill_trial');

      expect(result.authorized).toBe(true);
      expect(result.trial).toBe(true);
    });

    it('should deny expired trial skill', async () => {
      mockPlatformClient.getOrganizationSkills.mockResolvedValue([
        {
          id: 'skill_expired',
          name: 'Expired Trial',
          status: 'trial',
          trialExpiresAt: Date.now() - 86400000, // 1 day ago
        },
      ]);

      const result = await verifier.verifySkillPermission('skill_expired');

      expect(result.authorized).toBe(false);
      expect(result.reason).toContain('Trial expired');
    });
  });

  describe('executeSkillTool', () => {
    it('should execute tool if skill is authorized', async () => {
      mockPlatformClient.getOrganizationSkills.mockResolvedValue([
        { id: 'skill_123', name: 'Test Skill', status: 'active' },
      ]);

      const mockToolExecutor = vi.fn().mockResolvedValue({ result: 'success' });

      const result = await verifier.executeSkillTool({
        skillId: 'skill_123',
        toolName: 'test_tool',
        params: { param1: 'value1' },
        toolExecutor: mockToolExecutor,
      });

      expect(result).toEqual({ result: 'success' });
      expect(mockToolExecutor).toHaveBeenCalledWith({ param1: 'value1' });
    });

    it('should throw error if skill is not authorized', async () => {
      mockPlatformClient.getOrganizationSkills.mockResolvedValue([]);

      const mockToolExecutor = vi.fn();

      await expect(
        verifier.executeSkillTool({
          skillId: 'unauthorized_skill',
          toolName: 'test_tool',
          params: {},
          toolExecutor: mockToolExecutor,
        })
      ).rejects.toThrow('Skill unauthorized_skill not authorized');

      expect(mockToolExecutor).not.toHaveBeenCalled();
    });

    it('should log permission check', async () => {
      mockPlatformClient.getOrganizationSkills.mockResolvedValue([
        { id: 'skill_123', name: 'Test Skill', status: 'active' },
      ]);

      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await verifier.executeSkillTool({
        skillId: 'skill_123',
        toolName: 'test_tool',
        params: {},
        toolExecutor: vi.fn(),
      });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skill permission check')
      );

      consoleLogSpy.mockRestore();
    });
  });

  describe('getUserSkillPermissions', () => {
    it('should return user-specific permissions', async () => {
      mockPlatformClient.getOrganizationSkills.mockResolvedValue([
        {
          id: 'skill_1',
          name: 'Skill 1',
          status: 'active',
          userPermissions: {
            user_abc456: ['read', 'execute'],
            user_xyz: ['read'],
          },
        },
      ]);

      const permissions = await verifier.getUserSkillPermissions('skill_1');

      expect(permissions).toEqual(['read', 'execute']);
    });

    it('should return default permissions if user-specific not set', async () => {
      mockPlatformClient.getOrganizationSkills.mockResolvedValue([
        {
          id: 'skill_1',
          name: 'Skill 1',
          status: 'active',
          defaultPermissions: ['read', 'execute'],
        },
      ]);

      const permissions = await verifier.getUserSkillPermissions('skill_1');

      expect(permissions).toEqual(['read', 'execute']);
    });
  });

  describe('multi-tenant isolation', () => {
    it('should only load skills for configured organization', async () => {
      await verifier.loadOrganizationSkills();

      expect(mockPlatformClient.getOrganizationSkills).toHaveBeenCalledWith('org_test123');
    });

    it('should prevent cross-organization skill access', async () => {
      // Attempt to verify skill for different org
      mockPlatformClient.verifySkillPermission.mockResolvedValue({
        authorized: false,
        reason: 'Cross-organization access denied',
      });

      const result = await verifier.verifySkillPermission('skill_from_other_org');

      expect(result.authorized).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should handle platform API errors gracefully', async () => {
      mockPlatformClient.getOrganizationSkills.mockRejectedValue(
        new Error('Platform API unavailable')
      );

      const result = await verifier.verifySkillPermission('skill_123');

      expect(result.authorized).toBe(false);
      expect(result.reason).toContain('Platform error');
    });

    it('should handle network timeouts', async () => {
      mockPlatformClient.getOrganizationSkills.mockRejectedValue(
        new Error('Request timeout')
      );

      await expect(verifier.loadOrganizationSkills()).rejects.toThrow(
        'Failed to load organization skills'
      );
    });
  });

  describe('caching behavior', () => {
    it('should respect cache TTL', async () => {
      vi.useFakeTimers();

      mockPlatformClient.getOrganizationSkills.mockResolvedValue([
        { id: 'skill_1', name: 'Skill 1', status: 'active' },
      ]);

      await verifier.loadOrganizationSkills();

      // Advance time beyond TTL (default 5 minutes)
      vi.advanceTimersByTime(6 * 60 * 1000);

      await verifier.loadOrganizationSkills();

      // Should have called API twice (cache expired)
      expect(mockPlatformClient.getOrganizationSkills).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });

  describe('skill metadata', () => {
    it('should include skill metadata in authorization result', async () => {
      mockPlatformClient.getOrganizationSkills.mockResolvedValue([
        {
          id: 'skill_123',
          name: 'Advanced Skill',
          status: 'active',
          version: '2.0.0',
          provider: 'ClawForge',
          category: 'productivity',
        },
      ]);

      const result = await verifier.verifySkillPermission('skill_123');

      expect(result.authorized).toBe(true);
      expect(result.metadata).toEqual({
        name: 'Advanced Skill',
        version: '2.0.0',
        provider: 'ClawForge',
        category: 'productivity',
      });
    });
  });
});
