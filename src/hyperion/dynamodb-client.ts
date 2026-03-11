import {
  DEFAULT_AGENT_ID,
  type ChannelLink,
  type HyperionDynamoDBConfig,
  type HyperionPlatform,
  type PairingCode,
  type TenantConfig,
  type UserCredentialsRecord,
} from "./types.js";

/**
 * Minimal DynamoDB document client interface.
 * Accepts any AWS SDK v3 DynamoDBDocumentClient-compatible implementation.
 */
export type DynamoDBDocClient = {
  send(command: unknown): Promise<unknown>;
};

/**
 * Wraps DynamoDB operations for Hyperion's three tables.
 * Designed to work with AWS SDK v3 DynamoDBDocumentClient.
 */
export class HyperionDynamoDBClient {
  private readonly config: HyperionDynamoDBConfig;
  private readonly docClient: DynamoDBDocClient;

  constructor(config: HyperionDynamoDBConfig, docClient: DynamoDBDocClient) {
    this.config = config;
    this.docClient = docClient;
  }

  // -- Tenant Config -- [claude-infra] composite key: user_id + agent_id

  async getTenantConfig(
    userId: string,
    agentId: string = DEFAULT_AGENT_ID,
  ): Promise<TenantConfig | null> {
    const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
    const result = await this.docClient.send(
      new GetCommand({
        TableName: this.config.tenantConfigTableName,
        Key: { user_id: userId, agent_id: agentId },
      }),
    );
    const item = (result as { Item?: TenantConfig }).Item;
    return item ?? null;
  }

  async listTenantAgents(userId: string): Promise<TenantConfig[]> {
    const { QueryCommand } = await import("@aws-sdk/lib-dynamodb");
    const result = await this.docClient.send(
      new QueryCommand({
        TableName: this.config.tenantConfigTableName,
        KeyConditionExpression: "user_id = :uid",
        ExpressionAttributeValues: { ":uid": userId },
      }),
    );
    return (result as { Items?: TenantConfig[] }).Items ?? [];
  }

  async putTenantConfig(tenantConfig: TenantConfig): Promise<void> {
    const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
    await this.docClient.send(
      new PutCommand({
        TableName: this.config.tenantConfigTableName,
        Item: {
          ...tenantConfig,
          agent_id: tenantConfig.agent_id || DEFAULT_AGENT_ID,
          updated_at: new Date().toISOString(),
        },
      }),
    );
  }

  async deleteTenantConfig(userId: string, agentId: string = DEFAULT_AGENT_ID): Promise<void> {
    const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
    await this.docClient.send(
      new DeleteCommand({
        TableName: this.config.tenantConfigTableName,
        Key: { user_id: userId, agent_id: agentId },
      }),
    );
  }

  // -- Channel Config --

  async getChannelLink(
    platform: HyperionPlatform,
    platformUserId: string,
  ): Promise<ChannelLink | null> {
    const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
    const result = await this.docClient.send(
      new GetCommand({
        TableName: this.config.channelConfigTableName,
        Key: { platform, platform_user_id: platformUserId },
      }),
    );
    const item = (result as { Item?: ChannelLink }).Item;
    return item ?? null;
  }

  async getChannelLinksForUser(userId: string): Promise<ChannelLink[]> {
    const { QueryCommand } = await import("@aws-sdk/lib-dynamodb");
    const result = await this.docClient.send(
      new QueryCommand({
        TableName: this.config.channelConfigTableName,
        IndexName: this.config.channelConfigUserIdIndexName,
        KeyConditionExpression: "user_id = :uid",
        ExpressionAttributeValues: { ":uid": userId },
      }),
    );
    const items = (result as { Items?: ChannelLink[] }).Items;
    return items ?? [];
  }

  async putChannelLink(channelLink: ChannelLink): Promise<void> {
    const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
    await this.docClient.send(
      new PutCommand({
        TableName: this.config.channelConfigTableName,
        Item: channelLink,
      }),
    );
  }

  async deleteChannelLink(platform: HyperionPlatform, platformUserId: string): Promise<void> {
    const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
    await this.docClient.send(
      new DeleteCommand({
        TableName: this.config.channelConfigTableName,
        Key: { platform, platform_user_id: platformUserId },
      }),
    );
  }

  // -- Pairing Codes --

  async getPairingCode(code: string): Promise<PairingCode | null> {
    const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
    const result = await this.docClient.send(
      new GetCommand({
        TableName: this.config.pairingCodesTableName,
        Key: { code },
      }),
    );
    const item = (result as { Item?: PairingCode }).Item;
    if (!item) {
      return null;
    }
    // DynamoDB TTL is eventually consistent — check expiry explicitly.
    if (item.expires_at <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return item;
  }

  async putPairingCode(pairingCode: PairingCode): Promise<void> {
    const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
    await this.docClient.send(
      new PutCommand({
        TableName: this.config.pairingCodesTableName,
        Item: pairingCode,
        ConditionExpression: "attribute_not_exists(code)",
      }),
    );
  }

  async deletePairingCode(code: string): Promise<void> {
    const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
    await this.docClient.send(
      new DeleteCommand({
        TableName: this.config.pairingCodesTableName,
        Key: { code },
      }),
    );
  }

  // -- User Credentials -- [claude-infra] composite key: user_id + agent_id

  async getUserCredentials(
    userId: string,
    agentId: string = DEFAULT_AGENT_ID,
  ): Promise<UserCredentialsRecord | null> {
    const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
    // Try agent-specific credentials first, then shared.
    const result = await this.docClient.send(
      new GetCommand({
        TableName: this.config.userCredentialsTableName,
        Key: { user_id: userId, agent_id: agentId },
      }),
    );
    const item = (result as { Item?: UserCredentialsRecord }).Item;
    if (item) {
      return item;
    }

    // Fall back to shared credentials if agent-specific not found.
    if (agentId !== "__shared__") {
      const sharedResult = await this.docClient.send(
        new GetCommand({
          TableName: this.config.userCredentialsTableName,
          Key: { user_id: userId, agent_id: "__shared__" },
        }),
      );
      return (sharedResult as { Item?: UserCredentialsRecord }).Item ?? null;
    }
    return null;
  }

  async putUserCredentials(record: UserCredentialsRecord): Promise<void> {
    const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
    await this.docClient.send(
      new PutCommand({
        TableName: this.config.userCredentialsTableName,
        Item: {
          ...record,
          agent_id: record.agent_id || DEFAULT_AGENT_ID,
        },
      }),
    );
  }

  async deleteUserCredentials(userId: string, agentId: string = DEFAULT_AGENT_ID): Promise<void> {
    const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
    await this.docClient.send(
      new DeleteCommand({
        TableName: this.config.userCredentialsTableName,
        Key: { user_id: userId, agent_id: agentId },
      }),
    );
  }
}
