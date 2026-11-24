export type FullSuiteVitestShard = {
  config: string;
  name: string;
  projects: string[];
};

export const runtimeConfigTestOwner: {
  root: string;
  include: string[];
  exclude: string[];
};

export const autoReplyCoreTestInclude: string[];
export const autoReplyCoreTestExclude: string[];
export const autoReplyTopLevelReplyTestInclude: string[];
export const autoReplyReplySubtreeTestInclude: string[];
export const tuiPtyTestFiles: string[];
export const fullSuiteVitestShards: FullSuiteVitestShard[];
