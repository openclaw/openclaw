/**
 * Settings Routes
 *
 * API endpoints for customer configuration and defaults.
 */

import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, queryMany } from '../../db/client.js';
import {
  getCustomerDefaults,
  setCustomerDefaults,
} from '../../services/batch-operations.js';
import { getAllowedModels } from '../../db/repositories/agent-repository.js';

const router = Router();

// ============================================================================
// DEFAULT PRESETS
// ============================================================================

/**
 * Get customer defaults for new agents
 * GET /api/v1/settings/defaults
 */
router.get('/defaults', async (req, res) => {
  try {
    const defaults = await getCustomerDefaults(req.customer!.id);

    res.json(defaults);
  } catch (error) {
    console.error('[Settings] Get defaults error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Update customer defaults
 * PUT /api/v1/settings/defaults
 */
router.put('/defaults', async (req, res) => {
  try {
    const input = z
      .object({
        templateId: z.string().uuid().nullable().optional(),
        soulId: z.string().uuid().nullable().optional(),
        skillIds: z.array(z.string().uuid()).max(20).optional(),
      })
      .parse(req.body);

    await setCustomerDefaults(req.customer!.id, input);

    const defaults = await getCustomerDefaults(req.customer!.id);

    res.json({
      message: 'Defaults updated',
      defaults,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.errors });
      return;
    }
    console.error('[Settings] Update defaults error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ============================================================================
// CUSTOMER CONFIG
// ============================================================================

/**
 * Get all customer config
 * GET /api/v1/settings/config
 */
router.get('/config', async (req, res) => {
  try {
    const results = await queryMany(
      `SELECT key, value FROM customer_config WHERE customer_id = $1`,
      [req.customer!.id]
    );

    const config: Record<string, unknown> = {};
    for (const row of results) {
      config[row.key as string] = row.value;
    }

    res.json({ config });
  } catch (error) {
    console.error('[Settings] Get config error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Set a config value
 * PUT /api/v1/settings/config/:key
 */
router.put('/config/:key', async (req, res) => {
  try {
    const key = z.string().min(1).max(255).parse(req.params.key);
    const { value } = z.object({ value: z.unknown() }).parse(req.body);

    // Validate key is allowed for customer modification
    const allowedKeys = [
      'webhook_url',
      'webhook_secret_enabled',
      'notification_email',
      'daily_report_enabled',
      'timezone',
      'language',
    ];

    if (!allowedKeys.includes(key)) {
      res.status(403).json({
        error: 'Forbidden',
        message: `Config key '${key}' cannot be modified`,
      });
      return;
    }

    await query(
      `INSERT INTO customer_config (customer_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (customer_id, key) DO UPDATE SET value = $3`,
      [req.customer!.id, key, JSON.stringify(value)]
    );

    res.json({ message: 'Config updated', key, value });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.errors });
      return;
    }
    console.error('[Settings] Set config error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Delete a config value
 * DELETE /api/v1/settings/config/:key
 */
router.delete('/config/:key', async (req, res) => {
  try {
    const key = z.string().min(1).max(255).parse(req.params.key);

    await query(
      `DELETE FROM customer_config WHERE customer_id = $1 AND key = $2`,
      [req.customer!.id, key]
    );

    res.json({ message: 'Config deleted', key });
  } catch (error) {
    console.error('[Settings] Delete config error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ============================================================================
// PLATFORM CONFIG (Read Only)
// ============================================================================

/**
 * Get available models
 * GET /api/v1/settings/models
 */
router.get('/models', async (_req, res) => {
  try {
    const models = getAllowedModels();

    // Get pricing from platform config
    const pricingResult = await queryOne(
      `SELECT value FROM platform_config WHERE key = 'token_costs'`
    );

    const pricing = pricingResult?.value as Record<
      string,
      { input: number; output: number }
    > || {};

    res.json({
      models: models.map((model) => ({
        id: model,
        name: model.split('-').slice(0, 2).join(' '),
        pricing: pricing[model] || { input: 0, output: 0 },
      })),
    });
  } catch (error) {
    console.error('[Settings] Get models error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Get rate limits for customer's plan
 * GET /api/v1/settings/limits
 */
router.get('/limits', async (req, res) => {
  try {
    const plan = req.customer!.plan || 'free';

    // Get rate limits from platform config
    const limitsResult = await queryOne(
      `SELECT value FROM platform_config WHERE key = 'default_rate_limits'`
    );

    const allLimits = limitsResult?.value as Record<
      string,
      { messages_per_day: number }
    > || {};

    const planLimits = allLimits[plan] || allLimits['free'] || { messages_per_day: 100 };

    res.json({
      plan,
      limits: {
        messagesPerDay: planLimits.messages_per_day,
        maxAgents: req.customer!.maxAgents,
      },
    });
  } catch (error) {
    console.error('[Settings] Get limits error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Get feature flags
 * GET /api/v1/settings/features
 */
router.get('/features', async (_req, res) => {
  try {
    const featuresResult = await queryOne(
      `SELECT value FROM platform_config WHERE key = 'features'`
    );

    const features = featuresResult?.value as Record<string, boolean> || {};

    res.json({ features });
  } catch (error) {
    console.error('[Settings] Get features error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ============================================================================
// WEBHOOK CONFIG
// ============================================================================

/**
 * Get webhook configuration
 * GET /api/v1/settings/webhook
 */
router.get('/webhook', async (req, res) => {
  try {
    const customer = req.customer!;

    res.json({
      webhookUrl: customer.webhookUrl,
      hasSecret: customer.hasWebhookSecret,
    });
  } catch (error) {
    console.error('[Settings] Get webhook error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Update webhook configuration
 * PUT /api/v1/settings/webhook
 */
router.put('/webhook', async (req, res) => {
  try {
    const { webhookUrl } = z
      .object({
        webhookUrl: z.string().url().nullable(),
      })
      .parse(req.body);

    // Update customer's webhook URL
    await query(
      `UPDATE customers SET webhook_url = $2 WHERE id = $1`,
      [req.customer!.id, webhookUrl]
    );

    // Generate new webhook secret if URL is set
    let webhookSecret: string | null = null;
    if (webhookUrl) {
      const { generateWebhookSecret } = await import('../../services/encryption.js');
      webhookSecret = generateWebhookSecret();

      await query(
        `UPDATE customers SET webhook_secret = $2 WHERE id = $1`,
        [req.customer!.id, webhookSecret]
      );
    } else {
      await query(
        `UPDATE customers SET webhook_secret = NULL WHERE id = $1`,
        [req.customer!.id]
      );
    }

    res.json({
      message: 'Webhook updated',
      webhookUrl,
      webhookSecret: webhookSecret ? `whsec_${webhookSecret.substring(0, 8)}...` : null,
      // Return full secret only on creation
      ...(webhookSecret && { newSecret: webhookSecret }),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.errors });
      return;
    }
    console.error('[Settings] Update webhook error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Rotate webhook secret
 * POST /api/v1/settings/webhook/rotate-secret
 */
router.post('/webhook/rotate-secret', async (req, res) => {
  try {
    if (!req.customer!.webhookUrl) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'No webhook URL configured',
      });
      return;
    }

    const { generateWebhookSecret } = await import('../../services/encryption.js');
    const webhookSecret = generateWebhookSecret();

    await query(
      `UPDATE customers SET webhook_secret = $2 WHERE id = $1`,
      [req.customer!.id, webhookSecret]
    );

    res.json({
      message: 'Webhook secret rotated',
      newSecret: webhookSecret,
    });
  } catch (error) {
    console.error('[Settings] Rotate webhook secret error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;
