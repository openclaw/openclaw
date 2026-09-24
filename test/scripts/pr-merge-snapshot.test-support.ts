// Octopool 0.6.10 (00c442d) routes only this exact landing query through its pool.
export const landingSnapshotQuery =
  'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){id databaseId url nameWithOwner ref(qualifiedName:"refs/heads/main"){target{oid}} pullRequest(number:$number){id number url state headRefOid baseRefName isDraft mergeCommit{oid} autoMergeRequest{mergeMethod} isInMergeQueue isMergeQueueEnabled mergeable mergeStateStatus}}}';

// Current protected writer route: a ref-scoped read is available to maintainers.
export const headFenceQuery =
  "query=query($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){id nameWithOwner url viewerPermission ref(qualifiedName:$ref){name prefix target{oid} branchProtectionRule{id pattern isAdminEnforced lockBranch lockAllowsFetchAndMerge allowsForcePushes allowsDeletions}}}}";
