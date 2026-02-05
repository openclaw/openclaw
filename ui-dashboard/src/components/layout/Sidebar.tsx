import { StatusDot, Badge, Avatar } from '../ui';
import styles from './Sidebar.module.css';

interface Track {
  id: string;
  name: string;
  status: 'active' | 'pending' | 'idle';
  taskCount?: number;
}

interface Worker {
  id: string;
  name: string;
  status: 'active' | 'pending' | 'idle';
  task?: string;
}

interface SidebarProps {
  tracks?: Track[];
  workers?: Worker[];
  reviewCount?: number;
  onTrackSelect?: (trackId: string) => void;
  onWorkerSelect?: (workerId: string) => void;
  selectedTrackId?: string;
}

export function Sidebar({
  tracks = [],
  workers = [],
  reviewCount = 0,
  onTrackSelect,
  onWorkerSelect,
  selectedTrackId,
}: SidebarProps) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionLabel}>Tracks</span>
          <span className={styles.sectionCount}>{tracks.length}</span>
        </div>
        {tracks.map((track) => (
          <div
            key={track.id}
            className={`${styles.item} ${selectedTrackId === track.id ? styles.active : ''}`}
            onClick={() => onTrackSelect?.(track.id)}
          >
            <StatusDot status={track.status} />
            <span className={styles.itemLabel}>{track.name}</span>
            {track.taskCount !== undefined && track.taskCount > 0 && (
              <Badge variant="success">{track.taskCount}</Badge>
            )}
          </div>
        ))}
      </div>

      {reviewCount > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionLabel}>Review Queue</span>
            <Badge variant="purple">{reviewCount}</Badge>
          </div>
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionLabel}>Workers</span>
          <span className={styles.sectionCount}>{workers.length}</span>
        </div>
        {workers.map((worker) => (
          <div
            key={worker.id}
            className={styles.item}
            onClick={() => onWorkerSelect?.(worker.id)}
          >
            <Avatar variant={worker.status === 'active' ? 'worker' : 'idle'} label={worker.name} size="sm" />
            <div className={styles.workerInfo}>
              <span className={styles.itemLabel}>{worker.name}</span>
              {worker.task && (
                <span className={styles.workerTask}>{worker.task}</span>
              )}
            </div>
            <StatusDot status={worker.status} />
          </div>
        ))}
      </div>
    </aside>
  );
}
