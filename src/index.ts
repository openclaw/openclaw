#!/usr/bin/env node
import { Command } from 'commander';
import dotenv from 'dotenv';
import process from 'node:process';
import Twilio from 'twilio';
import type { MessageInstance } from 'twilio/lib/rest/api/v2010/account/message.js';
import express, { type Request, type Response } from 'express';
import bodyParser from 'body-parser';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import JSON5 from 'json5';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';

dotenv.config({ quiet: true });

const program = new Command();
let globalVerbose = false;
let globalYes = false;

function setVerbose(v: boolean) {
  globalVerbose = v;
}

function logVerbose(message: string) {
  if (globalVerbose) console.log(chalk.gray(message));
}

function setYes(v: boolean) {
  globalYes = v;
}

type AuthMode =
  | { accountSid: string; authToken: string }
  | { accountSid: string; apiKey: string; apiSecret: string };

type GlobalOptions = {
  verbose: boolean;
  yes?: boolean;
};

type EnvConfig = {
  accountSid: string;
  whatsappFrom: string;
  whatsappSenderSid?: string;
  auth: AuthMode;
};

function readEnv(): EnvConfig {
  // Load and validate Twilio auth + sender configuration from env.
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const whatsappFrom = process.env.TWILIO_WHATSAPP_FROM;
  const whatsappSenderSid = process.env.TWILIO_SENDER_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const apiKey = process.env.TWILIO_API_KEY;
  const apiSecret = process.env.TWILIO_API_SECRET;

  if (!accountSid) {
    console.error('Missing env var TWILIO_ACCOUNT_SID');
    process.exit(1);
  }
  if (!whatsappFrom) {
    console.error('Missing env var TWILIO_WHATSAPP_FROM');
    process.exit(1);
  }

  let auth: AuthMode | undefined;
  if (apiKey && apiSecret) {
    auth = { accountSid, apiKey, apiSecret };
  } else if (authToken) {
    auth = { accountSid, authToken };
  } else {
    console.error('Provide either TWILIO_AUTH_TOKEN or (TWILIO_API_KEY and TWILIO_API_SECRET)');
    process.exit(1);
  }

  return {
    accountSid,
    whatsappFrom,
    whatsappSenderSid,
    auth
  };
}

const execFileAsync = promisify(execFile);

type ExecResult = { stdout: string; stderr: string };

type ExecOptions = { maxBuffer?: number; timeoutMs?: number };

async function runExec(
  command: string,
  args: string[],
  { maxBuffer = 2_000_000, timeoutMs }: ExecOptions = {}
): Promise<ExecResult> {
  // Thin wrapper around execFile with utf8 output.
  if (globalVerbose) {
    console.log(`$ ${command} ${args.join(' ')}`);
  }
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      maxBuffer,
      encoding: 'utf8',
      timeout: timeoutMs
    });
    if (globalVerbose) {
      if (stdout.trim()) console.log(stdout.trim());
      if (stderr.trim()) console.error(stderr.trim());
    }
    return { stdout, stderr };
  } catch (err) {
    if (globalVerbose) {
      console.error(danger(`Command failed: ${command} ${args.join(' ')}`));
    }
    throw err;
  }
}

async function ensureBinary(name: string): Promise<void> {
  // Abort early if a required CLI tool is missing.
  await runExec('which', [name]).catch(() => {
    console.error(`Missing required binary: ${name}. Please install it.`);
    process.exit(1);
  });
}

async function promptYesNo(question: string, defaultYes = false): Promise<boolean> {
  if (globalYes) return true;
  const rl = readline.createInterface({ input, output });
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const answer = (await rl.question(`${question}${suffix}`)).trim().toLowerCase();
  rl.close();
  if (!answer) return defaultYes;
  return answer.startsWith('y');
}

function withWhatsAppPrefix(number: string): string {
  // Ensure number has whatsapp: prefix expected by Twilio.
  return number.startsWith('whatsapp:') ? number : `whatsapp:${number}`;
}

const CONFIG_PATH = path.join(os.homedir(), '.warelay', 'warelay.json');
const success = chalk.green;
const warn = chalk.yellow;
const info = chalk.cyan;
const danger = chalk.red;

type ReplyMode = 'text' | 'command';

type WarelayConfig = {
  inbound?: {
    reply?: {
      mode: ReplyMode;
      text?: string; // for mode=text, can contain {{Body}}
      command?: string[]; // for mode=command, argv with templates
      template?: string; // prepend template string when building command/prompt
    };
  };
};

function loadConfig(): WarelayConfig {
  // Read ~/.warelay/warelay.json (JSON5) if present.
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON5.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as WarelayConfig;
  } catch (err) {
    console.error(`Failed to read config at ${CONFIG_PATH}`, err);
    return {};
  }
}

type MsgContext = {
  Body?: string;
  From?: string;
  To?: string;
  MessageSid?: string;
};

function applyTemplate(str: string, ctx: MsgContext) {
  // Simple {{Placeholder}} interpolation using inbound message context.
  return str.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    const value = (ctx as Record<string, unknown>)[key];
    return value == null ? '' : String(value);
  });
}

async function getReplyFromConfig(ctx: MsgContext): Promise<string | undefined> {
  // Choose reply from config: static text or external command stdout.
  const cfg = loadConfig();
  const reply = cfg.inbound?.reply;
  if (!reply) return undefined;

  if (reply.mode === 'text' && reply.text) {
    return applyTemplate(reply.text, ctx);
  }

  if (reply.mode === 'command' && reply.command?.length) {
    const argv = reply.command.map((part) => applyTemplate(part, ctx));
    const templatePrefix = reply.template ? applyTemplate(reply.template, ctx) : '';
    const finalArgv = templatePrefix ? [argv[0], templatePrefix, ...argv.slice(1)] : argv;
    try {
      const { stdout } = await execFileAsync(finalArgv[0], finalArgv.slice(1), {
        maxBuffer: 1024 * 1024
      });
      return stdout.trim();
    } catch (err) {
      console.error('Command auto-reply failed', err);
      return undefined;
    }
  }

  return undefined;
}

function createClient(env: EnvConfig) {
  // Twilio client using either auth token or API key/secret.
  if ('authToken' in env.auth) {
    return Twilio(env.accountSid, env.auth.authToken, {
      accountSid: env.accountSid
    });
  }
  return Twilio(env.auth.apiKey, env.auth.apiSecret, {
    accountSid: env.accountSid
  });
}

async function sendMessage(to: string, body: string) {
  // Send outbound WhatsApp message; exit non-zero on API failure.
  const env = readEnv();
  const client = createClient(env);
  const from = withWhatsAppPrefix(env.whatsappFrom);
  const toNumber = withWhatsAppPrefix(to);

  try {
    const message = await client.messages.create({
      from,
      to: toNumber,
      body
    });

    console.log(success(`✅ Request accepted. Message SID: ${message.sid} -> ${toNumber}`));
    return { client, sid: message.sid };
  } catch (err) {
    const anyErr = err as Record<string, unknown>;
    const code = anyErr?.['code'];
    const msg = anyErr?.['message'];
    const more = anyErr?.['moreInfo'];
    const status = anyErr?.['status'];
    console.error(
      `❌ Twilio send failed${code ? ` (code ${code})` : ''}${status ? ` status ${status}` : ''}: ${msg ?? err}`
    );
    if (more) console.error(`More info: ${more}`);
    // Some Twilio errors include response.body with more context.
    const responseBody = (anyErr?.['response'] as Record<string, unknown> | undefined)?.['body'];
    if (responseBody) {
      console.error('Response body:', JSON.stringify(responseBody, null, 2));
    }
    process.exit(1);
  }
}

const successTerminalStatuses = new Set(['delivered', 'read']);
const failureTerminalStatuses = new Set(['failed', 'undelivered', 'canceled']);

async function waitForFinalStatus(
  client: ReturnType<typeof createClient>,
  sid: string,
  timeoutSeconds: number,
  pollSeconds: number
) {
  // Poll message status until delivered/failed or timeout.
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const m = await client.messages(sid).fetch();
    const status = m.status ?? 'unknown';
    if (successTerminalStatuses.has(status)) {
      console.log(success(`✅ Delivered (status: ${status})`));
      return;
    }
    if (failureTerminalStatuses.has(status)) {
      console.error(
        `❌ Delivery failed (status: ${status}${
          m.errorCode ? `, code ${m.errorCode}` : ''
        })${m.errorMessage ? `: ${m.errorMessage}` : ''}`
      );
      process.exit(1);
    }
    await sleep(pollSeconds * 1000);
  }
  console.log('ℹ️  Timed out waiting for final status; message may still be in flight.');
}

async function startWebhook(
  port: number,
  path = '/webhook/whatsapp',
  autoReply: string | undefined,
  verbose: boolean
) {
  // Start Express webhook; generate replies via config or CLI flag.
  const env = readEnv();
  const app = express();

  // Twilio sends application/x-www-form-urlencoded
  app.use(bodyParser.urlencoded({ extended: false }));

  app.post(path, async (req: Request, res: Response) => {
    const { From, To, Body, MessageSid } = req.body ?? {};
    if (verbose) {
      console.log(`[INBOUND] ${From} -> ${To} (${MessageSid}): ${Body}`);
    }

    let replyText = autoReply;
    if (!replyText) {
      replyText = await getReplyFromConfig({
        Body,
        From,
        To,
        MessageSid
      });
    }

    if (replyText) {
      try {
        const client = createClient(env);
        await client.messages.create({
          from: To,
          to: From,
          body: replyText
        });
        if (verbose) {
          console.log(success(`↩️  Auto-replied to ${From}`));
        }
      } catch (err) {
        console.error('Failed to auto-reply', err);
      }
    }

    // Respond 200 OK to Twilio
    res.type('text/xml').send('<Response></Response>');
  });

  return new Promise<void>((resolve) => {
    app.listen(port, () => {
      console.log(`📥 Webhook listening on http://localhost:${port}${path}`);
      resolve();
    });
  });
}

async function getTailnetHostname() {
  // Derive tailnet hostname (or IP fallback) from tailscale status JSON.
  const { stdout } = await runExec('tailscale', ['status', '--json']);
  const parsed = stdout ? (JSON.parse(stdout) as Record<string, unknown>) : {};
  const self = parsed?.['Self'] as Record<string, unknown> | undefined;
  const dns = typeof self?.['DNSName'] === 'string' ? (self['DNSName'] as string) : undefined;
  const ips = Array.isArray(self?.['TailscaleIPs']) ? (self?.['TailscaleIPs'] as string[]) : [];
  if (dns && dns.length > 0) return dns.replace(/\.$/, '');
  if (ips.length > 0) return ips[0];
  throw new Error('Could not determine Tailscale DNS or IP');
}

async function ensureGoInstalled() {
  // Ensure Go toolchain is present; offer Homebrew install if missing.
  const hasGo = await runExec('go', ['version']).then(
    () => true,
    () => false
  );
  if (hasGo) return;
  const install = await promptYesNo('Go is not installed. Install via Homebrew (brew install go)?', true);
  if (!install) {
    console.error('Go is required to build tailscaled from source. Aborting.');
    process.exit(1);
  }
  logVerbose('Installing Go via Homebrew…');
  await runExec('brew', ['install', 'go']);
}

async function ensureTailscaledInstalled() {
  // Ensure tailscaled binary exists; install via Homebrew tailscale if missing.
  const hasTailscaled = await runExec('tailscaled', ['--version']).then(
    () => true,
    () => false
  );
  if (hasTailscaled) return;

  const install = await promptYesNo('tailscaled not found. Install via Homebrew (tailscale package)?', true);
  if (!install) {
    console.error('tailscaled is required for user-space funnel. Aborting.');
    process.exit(1);
  }
  logVerbose('Installing tailscaled via Homebrew…');
  await runExec('brew', ['install', 'tailscale']);
}

async function ensureFunnel(port: number) {
  // Ensure Funnel is enabled and publish the webhook port.
  try {
    const statusOut = (await runExec('tailscale', ['funnel', 'status', '--json'])).stdout.trim();
    const parsed = statusOut ? (JSON.parse(statusOut) as Record<string, unknown>) : {};
    if (!parsed || Object.keys(parsed).length === 0) {
      console.error(danger('Tailscale Funnel is not enabled on this tailnet/device.'));
      console.error(info('Enable in admin console: https://login.tailscale.com/admin (see https://tailscale.com/kb/1223/funnel)'));
      console.error(info('macOS user-space tailscaled docs: https://github.com/tailscale/tailscale/wiki/Tailscaled-on-macOS'));
      const proceed = await promptYesNo('Attempt local setup with user-space tailscaled?', true);
      if (!proceed) process.exit(1);
      await ensureGoInstalled();
      await ensureTailscaledInstalled();
    }

    logVerbose(`Enabling funnel on port ${port}…`);
    const { stdout } = await runExec('tailscale', ['funnel', '--yes', '--bg', `${port}`], {
      maxBuffer: 200_000,
      timeoutMs: 15_000
    });
    if (stdout.trim()) console.log(stdout.trim());
  } catch (err) {
    const anyErr = err as Record<string, unknown>;
    const stdout = typeof anyErr['stdout'] === 'string' ? (anyErr['stdout'] as string) : '';
    const stderr = typeof anyErr['stderr'] === 'string' ? (anyErr['stderr'] as string) : '';
    if (stdout.includes('Funnel is not enabled')) {
      console.error(danger('Funnel is not enabled on this tailnet/device.'));
      const linkMatch = stdout.match(/https?:\/\/\S+/);
      if (linkMatch) {
        console.error(info(`Enable it here: ${linkMatch[0]}`));
      } else {
        console.error(info('Enable in admin console: https://login.tailscale.com/admin (see https://tailscale.com/kb/1223/funnel)'));
      }
    }
    if (stderr.includes('client version') || stdout.includes('client version')) {
      console.error(warn('Tailscale client/server version mismatch detected; try updating tailscale/tailscaled.'));
    }
    console.error('Failed to enable Tailscale Funnel. Is it allowed on your tailnet?');
    if (globalVerbose) {
      if (stdout.trim()) console.error(chalk.gray(`stdout: ${stdout.trim()}`));
      if (stderr.trim()) console.error(chalk.gray(`stderr: ${stderr.trim()}`));
      console.error(err);
    }
    process.exit(1);
  }
}

async function findWhatsappSenderSid(client: ReturnType<typeof createClient>, from: string) {
  // Fetch sender SID that matches configured WhatsApp from number.
  try {
    const resp = await (client as unknown as { request: (options: Record<string, unknown>) => Promise<{ data?: unknown }> }).request({
      method: 'get',
      uri: 'https://messaging.twilio.com/v2/Channels/Senders',
      qs: { Channel: 'whatsapp', PageSize: 50 }
    });
    const data = resp?.data as Record<string, unknown> | undefined;
    const senders = Array.isArray((data as Record<string, unknown> | undefined)?.senders)
      ? (data as { senders: unknown[] }).senders
      : undefined;
    if (!senders) {
      throw new Error('List senders response missing "senders" array');
    }
    const match = senders.find(
      (s) =>
        typeof s === 'object' &&
        s !== null &&
        (s as Record<string, unknown>).sender_id === withWhatsAppPrefix(from)
    ) as { sid?: string } | undefined;
    if (!match || typeof match.sid !== 'string') {
      throw new Error(`Could not find sender ${withWhatsAppPrefix(from)} in Twilio account`);
    }
    return match.sid;
  } catch (err) {
    console.error(danger('Unable to list WhatsApp senders via Twilio API.'));
    if (globalVerbose) console.error(err);
    console.error(
      info(
        'Provide TWILIO_SENDER_SID in .env to skip lookup (find it in Twilio Console → Messaging → Senders → WhatsApp).'
      )
    );
    process.exit(1);
  }
}

async function updateWebhook(
  client: ReturnType<typeof createClient>,
  senderSid: string,
  url: string,
  method: 'POST' | 'GET' = 'POST'
) {
  // Point Twilio sender webhook at the provided URL.
  await (client as unknown as { request: (options: Record<string, unknown>) => Promise<unknown> })
    .request({
      method: 'post',
      uri: `https://messaging.twilio.com/v2/Channels/Senders/${senderSid}`,
      form: {
        CallbackUrl: url,
        CallbackMethod: method
      }
    })
    .catch((err) => {
      console.error(danger('Failed to set Twilio webhook.'));
      if (globalVerbose) console.error(err);
      console.error(info('Double-check your sender SID and credentials; you can set TWILIO_SENDER_SID to force a specific sender.'));
      process.exit(1);
    });
  console.log(success(`✅ Twilio webhook set to ${url}`));
}

function sleep(ms: number) {
  // Promise-based sleep utility.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function monitor(intervalSeconds: number, lookbackMinutes: number) {
  // Poll Twilio for inbound messages and stream them with de-dupe.
  const env = readEnv();
  const client = createClient(env);
  const from = withWhatsAppPrefix(env.whatsappFrom);

  let since = new Date(Date.now() - lookbackMinutes * 60_000);
  const seen = new Set<string>();

  console.log(
    `📡 Monitoring inbound messages to ${from} (poll ${intervalSeconds}s, lookback ${lookbackMinutes}m)`
  );

  const updateSince = (date?: Date | null) => {
    if (!date) return;
    if (date.getTime() > since.getTime()) {
      since = date;
    }
  };

  let keepRunning = true;
  process.on('SIGINT', () => {
    keepRunning = false;
    console.log('\n👋 Stopping monitor');
  });

  while (keepRunning) {
    try {
      const messages = await client.messages.list({
        to: from,
        dateSentAfter: since,
        limit: 50
      });

      messages
        .filter((m: MessageInstance) => m.direction === 'inbound')
        .sort((a: MessageInstance, b: MessageInstance) => {
          const da = a.dateCreated?.getTime() ?? 0;
          const db = b.dateCreated?.getTime() ?? 0;
          return da - db;
        })
        .forEach((m: MessageInstance) => {
          if (seen.has(m.sid)) return;
          seen.add(m.sid);
          const time = m.dateCreated?.toISOString() ?? 'unknown time';
          const fromNum = m.from ?? 'unknown sender';
          console.log(`\n[${time}] ${fromNum} -> ${m.to}: ${m.body ?? ''}`);
          updateSince(m.dateCreated);
        });
    } catch (err) {
      console.error('Error while polling messages', err);
    }

    await sleep(intervalSeconds * 1000);
  }
}

program.name('warelay').description('WhatsApp relay CLI using Twilio').version('1.0.0');

program
  .command('send')
  .description('Send a WhatsApp message')
  .requiredOption('-t, --to <number>', 'Recipient number in E.164 (e.g. +15551234567)')
  .requiredOption('-m, --message <text>', 'Message body')
  .option('-w, --wait <seconds>', 'Wait for delivery status (0 to skip)', '20')
  .option('-p, --poll <seconds>', 'Polling interval while waiting', '2')
  .addHelpText(
    'after',
    `
Examples:
  warelay send --to +15551234567 --message "Hi"                # wait 20s for delivery (default)
  warelay send --to +15551234567 --message "Hi" --wait 0       # fire-and-forget
  warelay send --to +15551234567 --message "Hi" --wait 60 --poll 3`
  )
  .action(async (opts) => {
    const waitSeconds = Number.parseInt(opts.wait, 10);
    const pollSeconds = Number.parseInt(opts.poll, 10);

    if (Number.isNaN(waitSeconds) || waitSeconds < 0) {
      console.error('Wait must be >= 0 seconds');
      process.exit(1);
    }
    if (Number.isNaN(pollSeconds) || pollSeconds <= 0) {
      console.error('Poll must be > 0 seconds');
      process.exit(1);
    }

    const result = await sendMessage(opts.to, opts.message);
    if (!result) return;
    if (waitSeconds === 0) return;
    await waitForFinalStatus(result.client, result.sid, waitSeconds, pollSeconds);
  });

program
  .command('monitor')
  .description('Poll Twilio for inbound WhatsApp messages')
  .option('-i, --interval <seconds>', 'Polling interval in seconds', '5')
  .option('-l, --lookback <minutes>', 'Initial lookback window in minutes', '5')
  .addHelpText(
    'after',
    `
Examples:
  warelay monitor                         # poll every 5s, look back 5 minutes
  warelay monitor --interval 2 --lookback 30`
  )
  .action(async (opts) => {
    const intervalSeconds = Number.parseInt(opts.interval, 10);
    const lookbackMinutes = Number.parseInt(opts.lookback, 10);

    if (Number.isNaN(intervalSeconds) || intervalSeconds <= 0) {
      console.error('Interval must be a positive integer');
      process.exit(1);
    }
    if (Number.isNaN(lookbackMinutes) || lookbackMinutes < 0) {
      console.error('Lookback must be >= 0 minutes');
      process.exit(1);
    }

    await monitor(intervalSeconds, lookbackMinutes);
  });

program
  .command('webhook')
  .description('Run a local webhook server for inbound WhatsApp (works with Tailscale/port forward)')
  .option('-p, --port <port>', 'Port to listen on', '42873')
  .option('-r, --reply <text>', 'Optional auto-reply text')
  .option('--path <path>', 'Webhook path', '/webhook/whatsapp')
  .option('--verbose', 'Log inbound and auto-replies', false)
  .option('-y, --yes', 'Auto-confirm prompts when possible', false)
  .addHelpText(
    'after',
    `
Examples:
  warelay webhook                       # listen on 42873
  warelay webhook --port 45000          # pick a high, less-colliding port
  warelay webhook --reply "Got it!"     # static auto-reply; otherwise use config file

With Tailscale:
  tailscale serve tcp 42873 127.0.0.1:42873
  (then set Twilio webhook URL to your tailnet IP:42873/webhook/whatsapp)`
  )
  .action(async (opts) => {
    setVerbose(Boolean(opts.verbose));
    setYes(Boolean(opts.yes));
    const port = Number.parseInt(opts.port, 10);
    if (Number.isNaN(port) || port <= 0 || port >= 65536) {
      console.error('Port must be between 1 and 65535');
      process.exit(1);
    }
    await startWebhook(port, opts.path, opts.reply, Boolean(opts.verbose));
  });

program
  .command('setup')
  .description('Auto-setup webhook + Tailscale Funnel + Twilio callback with sensible defaults')
  .option('-p, --port <port>', 'Port to listen on', '42873')
  .option('--path <path>', 'Webhook path', '/webhook/whatsapp')
  .option('--verbose', 'Verbose logging during setup/webhook', false)
  .option('-y, --yes', 'Auto-confirm prompts when possible', false)
  .action(async (opts) => {
    setVerbose(Boolean(opts.verbose));
    setYes(Boolean(opts.yes));
    const port = Number.parseInt(opts.port, 10);
    if (Number.isNaN(port) || port <= 0 || port >= 65536) {
      console.error('Port must be between 1 and 65535');
      process.exit(1);
    }

    // Validate env and binaries
    const env = readEnv();
    await ensureBinary('tailscale');

    // Enable Funnel first so we don't keep a webhook running on failure
    await ensureFunnel(port);
    const host = await getTailnetHostname();
    const publicUrl = `https://${host}${opts.path}`;
    console.log(`🌐 Public webhook URL (via Funnel): ${publicUrl}`);

    // Start webhook locally (after funnel success)
    await startWebhook(port, opts.path, undefined, Boolean(opts.verbose));

    // Configure Twilio sender webhook
    const client = createClient(env);
    const senderSid = await findWhatsappSenderSid(client, env.whatsappFrom);
    await updateWebhook(client, senderSid, publicUrl, 'POST');

    console.log('\nSetup complete. Leave this process running to keep the webhook online. Ctrl+C to stop.');
  });

program.parseAsync(process.argv);
