/**
 * API Server
 *
 * Express server for the multi-agent Heroku SaaS platform.
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializePool, closePool, healthCheck as dbHealthCheck } from '../db/client.js';
import { initializeRedis, closeRedis } from '../services/agent-manager.js';
import { customerAuth, adminAuth } from './middleware/auth.js';
import { apiRateLimit } from './middleware/rate-limit.js';
import { auditMiddleware } from './middleware/audit.js';

import adminRoutes from './routes/admin.js';
import agentRoutes from './routes/agents.js';
import credentialRoutes from './routes/credentials.js';
import presetRoutes from './routes/presets.js';
import analyticsRoutes from './routes/analytics.js';
import batchRoutes from './routes/batch.js';
import settingsRoutes from './routes/settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Environment configuration
const PORT = parseInt(process.env.PORT || '3000', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';

/**
 * Create and configure the Express application
 */
export function createApp(): Express {
  const app = express();

  // Security middleware
  app.use(helmet({
    contentSecurityPolicy: NODE_ENV === 'production',
  }));
  app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  }));
  app.use(compression());

  // Body parsing
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Request logging
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`[HTTP] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    });
    next();
  });

  // Health check endpoint (no auth required)
  app.get('/health', async (_req, res) => {
    const db = await dbHealthCheck();
    const status = db.ok ? 'healthy' : 'unhealthy';

    res.status(db.ok ? 200 : 503).json({
      status,
      timestamp: new Date().toISOString(),
      checks: {
        database: {
          status: db.ok ? 'up' : 'down',
          latency: `${db.latency}ms`,
          error: db.error,
        },
      },
    });
  });

  // API version info
  app.get('/api/v1', (_req, res) => {
    res.json({
      name: 'OpenClaw Multi-Agent API',
      version: '1.0.0',
      documentation: 'https://docs.openclaw.ai/multi-agent',
    });
  });

  // Audit middleware for all API routes
  app.use('/api', auditMiddleware());

  // Admin routes (admin auth required)
  app.use('/api/v1/admin', adminAuth, adminRoutes);

  // Customer-scoped routes (customer auth required)
  app.use('/api/v1/agents', customerAuth, apiRateLimit(), agentRoutes);

  // Credentials routes (nested under agents)
  app.use('/api/v1/agents', customerAuth, apiRateLimit(), credentialRoutes);

  // Preset routes (skills, souls, templates)
  app.use('/api/v1/presets', customerAuth, apiRateLimit(), presetRoutes);

  // Agent skills routes (from presets router)
  app.use('/api/v1', customerAuth, apiRateLimit(), presetRoutes);

  // Analytics routes
  app.use('/api/v1/analytics', customerAuth, apiRateLimit(), analyticsRoutes);

  // Batch operations routes
  app.use('/api/v1/batch', customerAuth, apiRateLimit(), batchRoutes);

  // Settings routes
  app.use('/api/v1/settings', customerAuth, apiRateLimit(), settingsRoutes);

  // Telegram webhook endpoint (special handling)
  app.post('/api/v1/webhook/telegram/:botId', async (req, res) => {
    // Telegram webhook handling will be implemented in worker
    // This endpoint just acknowledges receipt
    res.status(200).json({ ok: true });
  });

  // Serve dashboard static files
  const dashboardPath = path.join(__dirname, '..', 'dashboard');
  app.use('/dashboard', express.static(dashboardPath));

  // Dashboard fallback route
  app.get('/dashboard/*', (_req, res) => {
    res.sendFile(path.join(dashboardPath, 'index.html'));
  });

  // Redirect root to dashboard
  app.get('/', (_req, res) => {
    res.redirect('/dashboard');
  });

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({
      error: 'Not Found',
      message: 'The requested endpoint does not exist',
    });
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[Server] Unhandled error:', err);

    // Don't leak error details in production
    const message = NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : err.message;

    res.status(500).json({
      error: 'Internal Server Error',
      message,
    });
  });

  return app;
}

/**
 * Start the server
 */
export async function startServer(): Promise<void> {
  console.log('[Server] Starting...');

  // Initialize database
  console.log('[Server] Connecting to database...');
  initializePool();

  // Initialize Redis
  console.log('[Server] Connecting to Redis...');
  await initializeRedis();

  // Create and start app
  const app = createApp();

  const server = app.listen(PORT, () => {
    console.log(`[Server] Listening on port ${PORT} (${NODE_ENV})`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[Server] Received ${signal}, shutting down...`);

    server.close(async () => {
      console.log('[Server] HTTP server closed');

      await Promise.all([
        closePool(),
        closeRedis(),
      ]);

      console.log('[Server] Cleanup complete');
      process.exit(0);
    });

    // Force exit after timeout
    setTimeout(() => {
      console.error('[Server] Forced shutdown after timeout');
      process.exit(1);
    }, 30000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Start server if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((err) => {
    console.error('[Server] Failed to start:', err);
    process.exit(1);
  });
}
