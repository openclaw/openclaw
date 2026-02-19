import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { resolveStateDir } from "../../config/paths.js";
import type { Campaign, IndicatorOfCompromise, ThreatActor } from "../types.js";

export class ThreatIntelligenceStore {
  private baseDir: string;
  private actorsFile: string;
  private iocsFile: string;
  private campaignsFile: string;

  constructor(storagePath?: string) {
    const stateDir = resolveStateDir();
    this.baseDir = storagePath
      ? path.resolve(storagePath)
      : path.join(stateDir, "cybersecurity", "threats");
    this.actorsFile = path.join(this.baseDir, "actors.jsonl");
    this.iocsFile = path.join(this.baseDir, "iocs.jsonl");
    this.campaignsFile = path.join(this.baseDir, "campaigns.jsonl");

    // Ensure directory exists
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  // Threat Actor Operations

  async addActor(actor: ThreatActor): Promise<void> {
    const line = JSON.stringify(actor) + "\n";
    await fs.promises.appendFile(this.actorsFile, line, "utf-8");
  }

  async getActor(id: string): Promise<ThreatActor | null> {
    for await (const actor of this.listActors()) {
      if (actor.id === id) {
        return actor;
      }
    }
    return null;
  }

  async listActors(): AsyncGenerator<ThreatActor> {
    if (!fs.existsSync(this.actorsFile)) {
      return;
    }
    for await (const record of this.readJsonl(this.actorsFile)) {
      yield record as ThreatActor;
    }
  }

  async updateActor(id: string, updates: Partial<ThreatActor>): Promise<boolean> {
    const actors: ThreatActor[] = [];
    let found = false;

    for await (const actor of this.listActors()) {
      if (actor.id === id) {
        actors.push({ ...actor, ...updates, updatedAt: new Date() });
        found = true;
      } else {
        actors.push(actor);
      }
    }

    if (found) {
      await this.writeJsonl(this.actorsFile, actors);
    }
    return found;
  }

  // IOC Operations

  async addIoc(ioc: IndicatorOfCompromise): Promise<void> {
    const line = JSON.stringify(ioc) + "\n";
    await fs.promises.appendFile(this.iocsFile, line, "utf-8");
  }

  async getIoc(id: string): Promise<IndicatorOfCompromise | null> {
    for await (const ioc of this.listIocs()) {
      if (ioc.id === id) {
        return ioc;
      }
    }
    return null;
  }

  async listIocs(): AsyncGenerator<IndicatorOfCompromise> {
    if (!fs.existsSync(this.iocsFile)) {
      return;
    }
    for await (const record of this.readJsonl(this.iocsFile)) {
      yield record as IndicatorOfCompromise;
    }
  }

  async searchIocs(query: {
    value?: string;
    type?: string;
    actorId?: string;
    campaignId?: string;
  }): Promise<IndicatorOfCompromise[]> {
    const results: IndicatorOfCompromise[] = [];
    for await (const ioc of this.listIocs()) {
      if (query.value && !ioc.value.toLowerCase().includes(query.value.toLowerCase())) {
        continue;
      }
      if (query.type && ioc.type !== query.type) {
        continue;
      }
      if (query.actorId && ioc.actorId !== query.actorId) {
        continue;
      }
      if (query.campaignId && ioc.campaignId !== query.campaignId) {
        continue;
      }
      results.push(ioc);
    }
    return results;
  }

  async updateIoc(id: string, updates: Partial<IndicatorOfCompromise>): Promise<boolean> {
    const iocs: IndicatorOfCompromise[] = [];
    let found = false;

    for await (const ioc of this.listIocs()) {
      if (ioc.id === id) {
        iocs.push({ ...ioc, ...updates, updatedAt: new Date() });
        found = true;
      } else {
        iocs.push(ioc);
      }
    }

    if (found) {
      await this.writeJsonl(this.iocsFile, iocs);
    }
    return found;
  }

  // Campaign Operations

  async addCampaign(campaign: Campaign): Promise<void> {
    const line = JSON.stringify(campaign) + "\n";
    await fs.promises.appendFile(this.campaignsFile, line, "utf-8");
  }

  async getCampaign(id: string): Promise<Campaign | null> {
    for await (const campaign of this.listCampaigns()) {
      if (campaign.id === id) {
        return campaign;
      }
    }
    return null;
  }

  async listCampaigns(): AsyncGenerator<Campaign> {
    if (!fs.existsSync(this.campaignsFile)) {
      return;
    }
    for await (const record of this.readJsonl(this.campaignsFile)) {
      yield record as Campaign;
    }
  }

  async searchCampaigns(query: {
    actorId?: string;
    status?: string;
    sector?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<Campaign[]> {
    const results: Campaign[] = [];
    for await (const campaign of this.listCampaigns()) {
      if (query.actorId && campaign.actorId !== query.actorId) {
        continue;
      }
      if (query.status && campaign.status !== query.status) {
        continue;
      }
      if (query.sector && !campaign.sectors?.includes(query.sector)) {
        continue;
      }
      if (query.startDate && campaign.startDate && campaign.startDate < query.startDate) {
        continue;
      }
      if (query.endDate && campaign.endDate && campaign.endDate > query.endDate) {
        continue;
      }
      results.push(campaign);
    }
    return results;
  }

  async updateCampaign(id: string, updates: Partial<Campaign>): Promise<boolean> {
    const campaigns: Campaign[] = [];
    let found = false;

    for await (const campaign of this.listCampaigns()) {
      if (campaign.id === id) {
        campaigns.push({ ...campaign, ...updates, updatedAt: new Date() });
        found = true;
      } else {
        campaigns.push(campaign);
      }
    }

    if (found) {
      await this.writeJsonl(this.campaignsFile, campaigns);
    }
    return found;
  }

  // Helper methods

  private async* readJsonl(filePath: string): AsyncGenerator<Record<string, unknown>> {
    if (!fs.existsSync(filePath)) {
      return;
    }
    const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (!parsed || typeof parsed !== "object") {
            continue;
          }
          yield parsed as Record<string, unknown>;
        } catch {
          // Ignore malformed lines
        }
      }
    } finally {
      rl.close();
      fileStream.destroy();
    }
  }

  private async writeJsonl(filePath: string, records: unknown[]): Promise<void> {
    const lines = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    await fs.promises.writeFile(filePath, lines, "utf-8");
  }
}
