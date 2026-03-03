import AjvPkg from "ajv";
import { AgentEventSchema, AgentIdentityParamsSchema, AgentIdentityResultSchema, AgentParamsSchema, AgentSummarySchema, AgentsFileEntrySchema, AgentsCreateParamsSchema, AgentsCreateResultSchema, AgentsUpdateParamsSchema, AgentsUpdateResultSchema, AgentsDeleteParamsSchema, AgentsDeleteResultSchema, AgentsFilesGetParamsSchema, AgentsFilesGetResultSchema, AgentsFilesListParamsSchema, AgentsFilesListResultSchema, AgentsFilesSetParamsSchema, AgentsFilesSetResultSchema, AgentsListParamsSchema, AgentsListResultSchema, AgentWaitParamsSchema, ChannelsLogoutParamsSchema, TalkConfigParamsSchema, TalkConfigResultSchema, ChannelsStatusParamsSchema, ChannelsStatusResultSchema, ChatAbortParamsSchema, ChatEventSchema, ChatHistoryParamsSchema, ChatInjectParamsSchema, ChatSendParamsSchema, ConfigApplyParamsSchema, ConfigGetParamsSchema, ConfigPatchParamsSchema, ConfigSchemaParamsSchema, ConfigSchemaResponseSchema, ConfigSetParamsSchema, ConnectParamsSchema, CronAddParamsSchema, CronJobSchema, CronListParamsSchema, CronRemoveParamsSchema, CronRunParamsSchema, CronRunsParamsSchema, CronStatusParamsSchema, CronUpdateParamsSchema, DevicePairApproveParamsSchema, DevicePairListParamsSchema, DevicePairRemoveParamsSchema, DevicePairRejectParamsSchema, DeviceTokenRevokeParamsSchema, DeviceTokenRotateParamsSchema, ExecApprovalsGetParamsSchema, ExecApprovalsNodeGetParamsSchema, ExecApprovalsNodeSetParamsSchema, ExecApprovalsSetParamsSchema, ExecApprovalRequestParamsSchema, ExecApprovalResolveParamsSchema, ErrorCodes, ErrorShapeSchema, EventFrameSchema, errorShape, GatewayFrameSchema, HelloOkSchema, LogsTailParamsSchema, LogsTailResultSchema, ModelsListParamsSchema, NodeDescribeParamsSchema, NodeEventParamsSchema, NodeInvokeParamsSchema, NodeInvokeResultParamsSchema, NodeListParamsSchema, NodePairApproveParamsSchema, NodePairListParamsSchema, NodePairRejectParamsSchema, NodePairRequestParamsSchema, NodePairVerifyParamsSchema, NodeRenameParamsSchema, PollParamsSchema, PROTOCOL_VERSION, PushTestParamsSchema, PushTestResultSchema, PresenceEntrySchema, ProtocolSchemas, RequestFrameSchema, ResponseFrameSchema, SendParamsSchema, SessionsCompactParamsSchema, SessionsDeleteParamsSchema, SessionsListParamsSchema, SessionsPatchParamsSchema, SessionsPreviewParamsSchema, SessionsResetParamsSchema, SessionsResolveParamsSchema, SessionsUsageParamsSchema, ShutdownEventSchema, SkillsBinsParamsSchema, SkillsInstallParamsSchema, SkillsStatusParamsSchema, SkillsUpdateParamsSchema, ToolsCatalogParamsSchema, SnapshotSchema, StateVersionSchema, TalkModeParamsSchema, TickEventSchema, UpdateRunParamsSchema, WakeParamsSchema, WebLoginStartParamsSchema, WebLoginWaitParamsSchema, WizardCancelParamsSchema, WizardNextParamsSchema, WizardNextResultSchema, WizardStartParamsSchema, WizardStartResultSchema, WizardStatusParamsSchema, WizardStatusResultSchema, WizardStepSchema, } from "./schema.js";
const ajv = new AjvPkg({
    allErrors: true,
    strict: false,
    removeAdditional: false,
});
export const validateConnectParams = ajv.compile(ConnectParamsSchema);
export const validateRequestFrame = ajv.compile(RequestFrameSchema);
export const validateResponseFrame = ajv.compile(ResponseFrameSchema);
export const validateEventFrame = ajv.compile(EventFrameSchema);
export const validateSendParams = ajv.compile(SendParamsSchema);
export const validatePollParams = ajv.compile(PollParamsSchema);
export const validateAgentParams = ajv.compile(AgentParamsSchema);
export const validateAgentIdentityParams = ajv.compile(AgentIdentityParamsSchema);
export const validateAgentWaitParams = ajv.compile(AgentWaitParamsSchema);
export const validateWakeParams = ajv.compile(WakeParamsSchema);
export const validateAgentsListParams = ajv.compile(AgentsListParamsSchema);
export const validateAgentsCreateParams = ajv.compile(AgentsCreateParamsSchema);
export const validateAgentsUpdateParams = ajv.compile(AgentsUpdateParamsSchema);
export const validateAgentsDeleteParams = ajv.compile(AgentsDeleteParamsSchema);
export const validateAgentsFilesListParams = ajv.compile(AgentsFilesListParamsSchema);
export const validateAgentsFilesGetParams = ajv.compile(AgentsFilesGetParamsSchema);
export const validateAgentsFilesSetParams = ajv.compile(AgentsFilesSetParamsSchema);
export const validateNodePairRequestParams = ajv.compile(NodePairRequestParamsSchema);
export const validateNodePairListParams = ajv.compile(NodePairListParamsSchema);
export const validateNodePairApproveParams = ajv.compile(NodePairApproveParamsSchema);
export const validateNodePairRejectParams = ajv.compile(NodePairRejectParamsSchema);
export const validateNodePairVerifyParams = ajv.compile(NodePairVerifyParamsSchema);
export const validateNodeRenameParams = ajv.compile(NodeRenameParamsSchema);
export const validateNodeListParams = ajv.compile(NodeListParamsSchema);
export const validateNodeDescribeParams = ajv.compile(NodeDescribeParamsSchema);
export const validateNodeInvokeParams = ajv.compile(NodeInvokeParamsSchema);
export const validateNodeInvokeResultParams = ajv.compile(NodeInvokeResultParamsSchema);
export const validateNodeEventParams = ajv.compile(NodeEventParamsSchema);
export const validatePushTestParams = ajv.compile(PushTestParamsSchema);
export const validateSessionsListParams = ajv.compile(SessionsListParamsSchema);
export const validateSessionsPreviewParams = ajv.compile(SessionsPreviewParamsSchema);
export const validateSessionsResolveParams = ajv.compile(SessionsResolveParamsSchema);
export const validateSessionsPatchParams = ajv.compile(SessionsPatchParamsSchema);
export const validateSessionsResetParams = ajv.compile(SessionsResetParamsSchema);
export const validateSessionsDeleteParams = ajv.compile(SessionsDeleteParamsSchema);
export const validateSessionsCompactParams = ajv.compile(SessionsCompactParamsSchema);
export const validateSessionsUsageParams = ajv.compile(SessionsUsageParamsSchema);
export const validateConfigGetParams = ajv.compile(ConfigGetParamsSchema);
export const validateConfigSetParams = ajv.compile(ConfigSetParamsSchema);
export const validateConfigApplyParams = ajv.compile(ConfigApplyParamsSchema);
export const validateConfigPatchParams = ajv.compile(ConfigPatchParamsSchema);
export const validateConfigSchemaParams = ajv.compile(ConfigSchemaParamsSchema);
export const validateWizardStartParams = ajv.compile(WizardStartParamsSchema);
export const validateWizardNextParams = ajv.compile(WizardNextParamsSchema);
export const validateWizardCancelParams = ajv.compile(WizardCancelParamsSchema);
export const validateWizardStatusParams = ajv.compile(WizardStatusParamsSchema);
export const validateTalkModeParams = ajv.compile(TalkModeParamsSchema);
export const validateTalkConfigParams = ajv.compile(TalkConfigParamsSchema);
export const validateChannelsStatusParams = ajv.compile(ChannelsStatusParamsSchema);
export const validateChannelsLogoutParams = ajv.compile(ChannelsLogoutParamsSchema);
export const validateModelsListParams = ajv.compile(ModelsListParamsSchema);
export const validateSkillsStatusParams = ajv.compile(SkillsStatusParamsSchema);
export const validateToolsCatalogParams = ajv.compile(ToolsCatalogParamsSchema);
export const validateSkillsBinsParams = ajv.compile(SkillsBinsParamsSchema);
export const validateSkillsInstallParams = ajv.compile(SkillsInstallParamsSchema);
export const validateSkillsUpdateParams = ajv.compile(SkillsUpdateParamsSchema);
export const validateCronListParams = ajv.compile(CronListParamsSchema);
export const validateCronStatusParams = ajv.compile(CronStatusParamsSchema);
export const validateCronAddParams = ajv.compile(CronAddParamsSchema);
export const validateCronUpdateParams = ajv.compile(CronUpdateParamsSchema);
export const validateCronRemoveParams = ajv.compile(CronRemoveParamsSchema);
export const validateCronRunParams = ajv.compile(CronRunParamsSchema);
export const validateCronRunsParams = ajv.compile(CronRunsParamsSchema);
export const validateDevicePairListParams = ajv.compile(DevicePairListParamsSchema);
export const validateDevicePairApproveParams = ajv.compile(DevicePairApproveParamsSchema);
export const validateDevicePairRejectParams = ajv.compile(DevicePairRejectParamsSchema);
export const validateDevicePairRemoveParams = ajv.compile(DevicePairRemoveParamsSchema);
export const validateDeviceTokenRotateParams = ajv.compile(DeviceTokenRotateParamsSchema);
export const validateDeviceTokenRevokeParams = ajv.compile(DeviceTokenRevokeParamsSchema);
export const validateExecApprovalsGetParams = ajv.compile(ExecApprovalsGetParamsSchema);
export const validateExecApprovalsSetParams = ajv.compile(ExecApprovalsSetParamsSchema);
export const validateExecApprovalRequestParams = ajv.compile(ExecApprovalRequestParamsSchema);
export const validateExecApprovalResolveParams = ajv.compile(ExecApprovalResolveParamsSchema);
export const validateExecApprovalsNodeGetParams = ajv.compile(ExecApprovalsNodeGetParamsSchema);
export const validateExecApprovalsNodeSetParams = ajv.compile(ExecApprovalsNodeSetParamsSchema);
export const validateLogsTailParams = ajv.compile(LogsTailParamsSchema);
export const validateChatHistoryParams = ajv.compile(ChatHistoryParamsSchema);
export const validateChatSendParams = ajv.compile(ChatSendParamsSchema);
export const validateChatAbortParams = ajv.compile(ChatAbortParamsSchema);
export const validateChatInjectParams = ajv.compile(ChatInjectParamsSchema);
export const validateChatEvent = ajv.compile(ChatEventSchema);
export const validateUpdateRunParams = ajv.compile(UpdateRunParamsSchema);
export const validateWebLoginStartParams = ajv.compile(WebLoginStartParamsSchema);
export const validateWebLoginWaitParams = ajv.compile(WebLoginWaitParamsSchema);
export function formatValidationErrors(errors) {
    if (!errors?.length) {
        return "unknown validation error";
    }
    const parts = [];
    for (const err of errors) {
        const keyword = typeof err?.keyword === "string" ? err.keyword : "";
        const instancePath = typeof err?.instancePath === "string" ? err.instancePath : "";
        if (keyword === "additionalProperties") {
            const params = err?.params;
            const additionalProperty = params?.additionalProperty;
            if (typeof additionalProperty === "string" && additionalProperty.trim()) {
                const where = instancePath ? `at ${instancePath}` : "at root";
                parts.push(`${where}: unexpected property '${additionalProperty}'`);
                continue;
            }
        }
        const message = typeof err?.message === "string" && err.message.trim() ? err.message : "validation error";
        const where = instancePath ? `at ${instancePath}: ` : "";
        parts.push(`${where}${message}`);
    }
    // De-dupe while preserving order.
    const unique = Array.from(new Set(parts.filter((part) => part.trim())));
    if (!unique.length) {
        const fallback = ajv.errorsText(errors, { separator: "; " });
        return fallback || "unknown validation error";
    }
    return unique.join("; ");
}
export { ConnectParamsSchema, HelloOkSchema, RequestFrameSchema, ResponseFrameSchema, EventFrameSchema, GatewayFrameSchema, PresenceEntrySchema, SnapshotSchema, ErrorShapeSchema, StateVersionSchema, AgentEventSchema, ChatEventSchema, SendParamsSchema, PollParamsSchema, AgentParamsSchema, AgentIdentityParamsSchema, AgentIdentityResultSchema, WakeParamsSchema, PushTestParamsSchema, PushTestResultSchema, NodePairRequestParamsSchema, NodePairListParamsSchema, NodePairApproveParamsSchema, NodePairRejectParamsSchema, NodePairVerifyParamsSchema, NodeListParamsSchema, NodeInvokeParamsSchema, SessionsListParamsSchema, SessionsPreviewParamsSchema, SessionsPatchParamsSchema, SessionsResetParamsSchema, SessionsDeleteParamsSchema, SessionsCompactParamsSchema, SessionsUsageParamsSchema, ConfigGetParamsSchema, ConfigSetParamsSchema, ConfigApplyParamsSchema, ConfigPatchParamsSchema, ConfigSchemaParamsSchema, ConfigSchemaResponseSchema, WizardStartParamsSchema, WizardNextParamsSchema, WizardCancelParamsSchema, WizardStatusParamsSchema, WizardStepSchema, WizardNextResultSchema, WizardStartResultSchema, WizardStatusResultSchema, TalkConfigParamsSchema, TalkConfigResultSchema, ChannelsStatusParamsSchema, ChannelsStatusResultSchema, ChannelsLogoutParamsSchema, WebLoginStartParamsSchema, WebLoginWaitParamsSchema, AgentSummarySchema, AgentsFileEntrySchema, AgentsCreateParamsSchema, AgentsCreateResultSchema, AgentsUpdateParamsSchema, AgentsUpdateResultSchema, AgentsDeleteParamsSchema, AgentsDeleteResultSchema, AgentsFilesListParamsSchema, AgentsFilesListResultSchema, AgentsFilesGetParamsSchema, AgentsFilesGetResultSchema, AgentsFilesSetParamsSchema, AgentsFilesSetResultSchema, AgentsListParamsSchema, AgentsListResultSchema, ModelsListParamsSchema, SkillsStatusParamsSchema, ToolsCatalogParamsSchema, SkillsInstallParamsSchema, SkillsUpdateParamsSchema, CronJobSchema, CronListParamsSchema, CronStatusParamsSchema, CronAddParamsSchema, CronUpdateParamsSchema, CronRemoveParamsSchema, CronRunParamsSchema, CronRunsParamsSchema, LogsTailParamsSchema, LogsTailResultSchema, ChatHistoryParamsSchema, ChatSendParamsSchema, ChatInjectParamsSchema, UpdateRunParamsSchema, TickEventSchema, ShutdownEventSchema, ProtocolSchemas, PROTOCOL_VERSION, ErrorCodes, errorShape, };
