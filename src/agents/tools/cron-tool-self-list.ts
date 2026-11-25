import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readCanonicalCronListPage,
  resolveCronListPageNextOffset,
} from "../../cron/service/list-page-validation.js";

const CRON_SELF_LIST_MAX_PAGES = 50;

function filterDeliveryPreviewsByJobId(previews: unknown, jobId: string): unknown {
  if (!isRecord(previews)) {
    return previews;
  }
  return Object.hasOwn(previews, jobId) ? { [jobId]: previews[jobId] } : {};
}

function filterCronListResultToJobId(
  result: ReturnType<typeof readCanonicalCronListPage> & { deliveryPreviews?: unknown },
  jobId: string,
) {
  const jobs = result.jobs.filter((job) => isRecord(job) && job.id === jobId);
  const { snapshotRevision: _snapshotRevision, ...page } = result;
  return {
    ...page,
    jobs,
    total: jobs.length,
    offset: 0,
    limit: jobs.length,
    hasMore: false,
    nextOffset: null,
    ...(Object.hasOwn(result, "deliveryPreviews")
      ? { deliveryPreviews: filterDeliveryPreviewsByJobId(result.deliveryPreviews, jobId) }
      : {}),
  };
}

export async function listCronSelfJob(params: {
  jobId: string;
  pageSize: number;
  requestPage: (params: { limit: number; offset: number }) => Promise<unknown>;
}): Promise<unknown> {
  let offset = 0;
  // Concurrent inventory edits are best effort; a repeated list reads their new positions.
  for (let pageNumber = 0; pageNumber < CRON_SELF_LIST_MAX_PAGES; pageNumber += 1) {
    const page = readCanonicalCronListPage(
      await params.requestPage({ limit: params.pageSize, offset }),
      params.pageSize,
    );
    const nextOffset = resolveCronListPageNextOffset(page, offset);
    if (page.jobs.some((job) => isRecord(job) && job.id === params.jobId) || nextOffset === null) {
      return filterCronListResultToJobId(page, params.jobId);
    }
    offset = nextOffset;
  }
  throw new Error("cron.list pagination exceeded maximum pages while reading current automation");
}
