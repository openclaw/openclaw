export type GovdossAuditRecord = {
  id: string;
  tenantId?: string;
  subject: string;
  action: string;
  object?: string;
  result: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
};

export class GovdossAuditStore {
  private readonly records: GovdossAuditRecord[] = [];
  private readonly maxRecords: number;

  constructor(maxRecords = 5000) {
    this.maxRecords = maxRecords;
  }

  append(record: GovdossAuditRecord): GovdossAuditRecord {
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
    return record;
  }

  listByTenant(tenantId?: string, limit = 100): GovdossAuditRecord[] {
    const filtered = tenantId
      ? this.records.filter((record) => record.tenantId === tenantId)
      : [...this.records];
    return filtered.slice(-limit).reverse();
  }
}

export const govdossAuditStore = new GovdossAuditStore();
