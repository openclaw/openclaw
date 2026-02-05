from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="Graphiti Adapter Service")


class Episode(BaseModel):
    id: str
    text: str
    source: Optional[str] = None
    tags: Optional[List[str]] = None
    observed_at: Optional[str] = None
    ingested_at: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    provenance: Optional[Dict[str, Any]] = None


class IngestEpisodesRequest(BaseModel):
    episodes: List[Episode] = Field(default_factory=list)
    traceId: Optional[str] = None
    warnings: Optional[List[Dict[str, Any]]] = None


class IngestEpisodesResponse(BaseModel):
    ok: bool
    nodeCount: int
    edgeCount: int
    error: Optional[str] = None


class QueryHybridRequest(BaseModel):
    query: str
    limit: Optional[int] = 10
    filters: Optional[Dict[str, Any]] = None
    traceId: Optional[str] = None


class GraphNodeDTO(BaseModel):
    id: str
    label: str
    properties: Optional[Dict[str, Any]] = None


class GraphEdgeDTO(BaseModel):
    id: str
    sourceId: str
    targetId: str
    relation: str
    properties: Optional[Dict[str, Any]] = None


class QueryHybridResponse(BaseModel):
    nodes: List[GraphNodeDTO]
    edges: List[GraphEdgeDTO]
    episodes: Optional[List[Episode]] = None
    latencyMs: Optional[int] = None
    error: Optional[str] = None


EPISODE_STORE: List[Episode] = []


@app.post("/ingestEpisodes", response_model=IngestEpisodesResponse)
def ingest_episodes(payload: IngestEpisodesRequest) -> IngestEpisodesResponse:
    EPISODE_STORE.extend(payload.episodes)
    return IngestEpisodesResponse(
        ok=True,
        nodeCount=len(payload.episodes),
        edgeCount=0,
    )


@app.post("/queryHybrid", response_model=QueryHybridResponse)
def query_hybrid(payload: QueryHybridRequest) -> QueryHybridResponse:
    start = datetime.now()
    query = payload.query.lower()
    matches = [episode for episode in EPISODE_STORE if query in episode.text.lower()]
    limited = matches[: payload.limit or 10]

    nodes = [
        GraphNodeDTO(id=episode.id, label="episode", properties={"text": episode.text})
        for episode in limited
    ]

    latency_ms = int((datetime.now() - start).total_seconds() * 1000)
    return QueryHybridResponse(nodes=nodes, edges=[], episodes=limited, latencyMs=latency_ms)
